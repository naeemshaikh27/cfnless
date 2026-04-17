import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import type { Config, EsbuildConfig } from '../types';

const CONFIG_FILENAMES = ['cfnless.yml', 'serverless.yml', 'cfnless.js', 'serverless.js'];

export function resolveConfigPath(workdir: string, configPath: string | null): string {
  if (configPath) {
    if (path.isAbsolute(configPath)) return configPath;
    return path.resolve(workdir, configPath);
  }
  // Auto-detect: try cfnless.yml first, then serverless.yml, then .js variants
  for (const name of CONFIG_FILENAMES) {
    const candidate = path.join(workdir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  // Fall back to cfnless.yml (will produce a clear "not found" error from loadConfig)
  return path.join(workdir, 'cfnless.yml');
}

export function loadConfig(configPath: string): Config {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }

  const ext = path.extname(configPath).toLowerCase();
  let raw: unknown;

  if (ext === '.js') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    delete require.cache[require.resolve(configPath)];
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    raw = require(configPath) as unknown;
  } else {
    const content = fs.readFileSync(configPath, 'utf8');
    raw = yaml.load(content);
  }

  return normalizeConfig(raw, configPath);
}

function normalizeConfig(raw: unknown, configPath: string): Config {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`Invalid config in ${configPath}: expected an object`);
  }

  const obj = raw as Record<string, unknown>;

  const service = obj.service as string | undefined;
  if (!service) {
    throw new Error(`Config missing required field "service" in ${configPath}`);
  }

  const provider = (obj.provider || {}) as Record<string, unknown>;
  if (!provider.name || provider.name !== 'aws') {
    throw new Error(`Only AWS provider is supported (got "${provider.name as string}")`);
  }
  if (!provider.region) {
    throw new Error(`Config missing required field "provider.region" in ${configPath}`);
  }

  const deploymentBucketObj = provider.deploymentBucket as Record<string, unknown> | undefined;
  const deploymentBucketName =
    deploymentBucketObj && deploymentBucketObj.name ? (deploymentBucketObj.name as string) : null;

  const functions = (obj.functions || {}) as Record<string, unknown>;

  const customObj = (obj.custom || {}) as Record<string, unknown>;
  const esbuildObj = (customObj.esbuild || {}) as Record<string, unknown>;
  const esbuild: EsbuildConfig = {
    ...(esbuildObj.tsconfig !== undefined && { tsconfig: esbuildObj.tsconfig as string }),
    ...(esbuildObj.minify !== undefined && { minify: esbuildObj.minify as boolean }),
    ...(esbuildObj.sourcemap !== undefined && { sourcemap: esbuildObj.sourcemap as EsbuildConfig['sourcemap'] }),
    // `exclude` is the serverless-esbuild canonical name; `external` is the esbuild-native alias
    ...(esbuildObj.exclude !== undefined && { exclude: esbuildObj.exclude as string[] }),
    ...(esbuildObj.external !== undefined && { external: esbuildObj.external as string[] }),
  };

  return {
    service,
    stage: (provider.stage as string) || 'dev',
    provider: {
      region: provider.region as string,
      runtime: (provider.runtime as string) || 'nodejs20.x',
      deploymentBucket: deploymentBucketName,
      deploymentPrefix: (provider.deploymentPrefix as string) || 'serverless',
      logRetentionInDays: (provider.logRetentionInDays as number) || 14,
    },
    functions: functions as Config['functions'],
    ...(Object.keys(esbuild).length > 0 && { custom: { esbuild } }),
  };
}
