import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { loadConfig, resolveConfigPath } from './config-loader';
import { LambdaManager } from './lambda-manager';
import { CloudWatchManager } from './cloudwatch-manager';
import { S3Uploader } from './s3-uploader';
import { bundleAndZip } from './bundler';
import type { FunctionConfig, NormalizedURLConfig, EsbuildConfig } from '../types';

export default async function deploy(
  workdir: string,
  configPath: string | null = null,
  functionFilter: string | null = null
): Promise<void> {
  const resolvedConfig = resolveConfigPath(workdir, configPath);
  const config = loadConfig(resolvedConfig);

  const { service, stage, provider, functions, custom } = config;
  const { region, runtime, deploymentBucket, deploymentPrefix, logRetentionInDays } = provider;

  const filteredFunctions = functionFilter
    ? Object.fromEntries(Object.entries(functions).filter(([k]) => k === functionFilter))
    : functions;

  if (functionFilter && Object.keys(filteredFunctions).length === 0) {
    throw new Error(`Function "${functionFilter}" not found in config`);
  }

  if (Object.keys(filteredFunctions).length === 0) {
    process.stderr.write('No functions defined — nothing to deploy\n');
    return;
  }

  const envVars = loadDotEnv(path.join(workdir, '.env'));

  const lambdaMgr = new LambdaManager(region);
  const cwMgr = new CloudWatchManager(region);
  const s3Uploader = new S3Uploader(region);

  process.stderr.write(`Deploying service: ${service} (${stage}) to ${region}\n`);
  process.stderr.write(`Functions: ${Object.keys(filteredFunctions).join(', ')}\n`);

  const deployPromises = Object.entries(filteredFunctions).map(([functionKey, funcConfig]) => {
    const functionName = `${service}-${stage}-${functionKey}`;
    return deployFunction({
      lambdaMgr,
      cwMgr,
      s3Uploader,
      functionName,
      functionKey,
      funcConfig,
      service,
      stage,
      workdir,
      envVars,
      deploymentBucket,
      deploymentPrefix,
      logRetentionInDays,
      runtime,
      esbuildOptions: custom?.esbuild,
    });
  });

  await Promise.all(deployPromises);

  process.stderr.write(`\nDeployment complete for service: ${service}\n`);

  const urlResults = await Promise.all(
    Object.keys(filteredFunctions).map(async (functionKey) => {
      const functionName = `${service}-${stage}-${functionKey}`;
      const url = await lambdaMgr.getFunctionUrl(functionName).catch(() => null);
      return { functionKey, functionName, url };
    })
  );

  const hasUrls = urlResults.some((r) => r.url);
  if (hasUrls) {
    if (urlResults.length === 1) {
      process.stderr.write(`endpoint: ${urlResults[0].url}\n`);
    } else {
      process.stderr.write(`endpoints:\n`);
      for (const { functionKey, url } of urlResults) {
        if (url) process.stderr.write(`  ${functionKey}: ${url}\n`);
      }
    }
  }
  process.stderr.write(`functions:\n`);
  for (const { functionKey, functionName } of urlResults) {
    process.stderr.write(`  ${functionKey}: ${functionName}\n`);
  }
}

interface DeployFunctionArgs {
  lambdaMgr: LambdaManager;
  cwMgr: CloudWatchManager;
  s3Uploader: S3Uploader;
  functionName: string;
  functionKey: string;
  funcConfig: FunctionConfig;
  service: string;
  stage: string;
  workdir: string;
  envVars: Record<string, string>;
  deploymentBucket: string | null;
  deploymentPrefix: string;
  logRetentionInDays: number;
  runtime: string;
  esbuildOptions: EsbuildConfig | undefined;
}

async function deployFunction({
  lambdaMgr,
  cwMgr,
  s3Uploader,
  functionName,
  functionKey,
  funcConfig,
  service,
  stage,
  workdir,
  envVars,
  deploymentBucket,
  deploymentPrefix,
  logRetentionInDays,
  runtime,
  esbuildOptions,
}: DeployFunctionArgs): Promise<void> {
  const logGroupName = `/aws/lambda/${functionName}`;
  const tags = buildTags(funcConfig.tags ?? {}, service);
  const urlConfig = normalizeUrlConfig(funcConfig.url);

  await cwMgr.createLogGroupIfNotExists(logGroupName, logRetentionInDays);

  if (funcConfig.image) {
    await lambdaMgr.createOrUpdateContainerFunction(functionName, {
      image: funcConfig.image,
      role: funcConfig.role!,
      timeout: funcConfig.timeout ?? 30,
      memorySize: funcConfig.memorySize ?? 1024,
      urlConfig,
      tags,
    });
  } else if (funcConfig.package?.artifact || funcConfig.artifact || funcConfig.handler) {
    if (!deploymentBucket) {
      throw new Error(
        'Deployment bucket name is required for zip functions — set provider.deploymentBucket in cfnless.yml'
      );
    }

    // package.artifact is the Serverless Framework-compatible field; bare artifact is the cfnless shorthand
    const artifactPath = funcConfig.package?.artifact ?? funcConfig.artifact;

    let zipFile: string;
    if (artifactPath) {
      process.stderr.write(`  Using pre-built artifact for ${functionKey}: ${artifactPath}\n`);
      zipFile = path.resolve(workdir, artifactPath);
    } else {
      process.stderr.write(`  Bundling ${functionKey} with esbuild...\n`);
      const handlerBase = funcConfig.handler!.replace(/\.[^.]+$/, '');
      ({ zipFile } = await bundleAndZip(
        handlerBase,
        workdir,
        runtimeToEsbuildTarget(funcConfig.runtime ?? runtime),
        functionName,
        esbuildOptions
      ));
    }

    const s3Key = `${deploymentPrefix}/${service}/${stage}/${functionName}.zip`;

    process.stderr.write(`  Uploading ${functionKey} to s3://${deploymentBucket}/${s3Key}\n`);
    await s3Uploader.uploadZip(zipFile, deploymentBucket, s3Key);

    await lambdaMgr.createOrUpdateZipFunction(functionName, {
      s3Bucket: deploymentBucket,
      s3Key,
      handler: artifactPath ? (funcConfig.handler ?? 'index.handler') : 'index.handler',
      role: funcConfig.role!,
      timeout: funcConfig.timeout ?? 30,
      memorySize: funcConfig.memorySize ?? 1024,
      runtime: funcConfig.runtime ?? runtime,
      environment: { ...envVars, ...(funcConfig.environment ?? {}) },
      urlConfig,
      tags,
    });
  } else {
    throw new Error(`Function "${functionKey}" has neither "image", "handler", nor "artifact"/"package.artifact" defined`);
  }
}

function loadDotEnv(envFilePath: string): Record<string, string> {
  if (!fs.existsSync(envFilePath)) {
    return {};
  }
  return dotenv.parse(fs.readFileSync(envFilePath));
}

function buildTags(configTags: Record<string, string>, service: string): Record<string, string> {
  return {
    ...configTags,
    ServerlessService: service,
  };
}

function normalizeUrlConfig(
  urlField: FunctionConfig['url']
): NormalizedURLConfig | null {
  if (!urlField) return null;
  if (urlField === true) return {};
  const u = urlField as { authorizer?: string | null; invokeMode?: string | null };
  return {
    authorizer: u.authorizer ?? null,
    invokeMode: u.invokeMode ?? null,
  };
}

function runtimeToEsbuildTarget(runtime: string): string {
  if (!runtime) return 'node20';
  const match = runtime.match(/nodejs(\d+)/);
  if (match) return `node${match[1]}`;
  return 'node20';
}
