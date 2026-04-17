import path from 'path';
import { loadConfig, resolveConfigPath } from './config-loader';
import { LambdaManager } from './lambda-manager';
import { CloudWatchManager } from './cloudwatch-manager';
import { S3Uploader } from './s3-uploader';
import {
  ResourceGroupsTaggingAPIClient,
  GetResourcesCommand,
} from '@aws-sdk/client-resource-groups-tagging-api';
import {
  CloudFormationClient,
  DeleteStackCommand,
  DescribeStacksCommand,
} from '@aws-sdk/client-cloudformation';

export default async function remove(
  workdir: string,
  configPath: string | null,
  removeCfnStack = false,
  removeServerlessS3Artifacts = false
): Promise<void> {
  const resolvedConfig = resolveConfigPath(workdir, configPath);
  const config = loadConfig(resolvedConfig);

  const { service, stage, provider } = config;
  const { region, deploymentBucket, deploymentPrefix } = provider;

  process.stderr.write(`Removing service: ${service} (${stage}) in ${region}\n`);

  const lambdaMgr = new LambdaManager(region);
  const cwMgr = new CloudWatchManager(region);
  const s3Mgr = new S3Uploader(region);

  const functionNames = await findFunctionsByTag(region, service);

  if (functionNames.length > 0) {
    process.stderr.write(
      `Found ${functionNames.length} function(s) tagged with ServerlessService=${service}\n`
    );
    await removeFunctions(functionNames, lambdaMgr, cwMgr);
  } else {
    process.stderr.write(`No SDK-deployed functions found for ${service}\n`);
  }

  if (deploymentBucket) {
    process.stderr.write(`Cleaning up S3 artifacts in bucket: ${deploymentBucket}\n`);
    await s3Mgr.deleteServiceZips(deploymentBucket, service, stage, deploymentPrefix);
  } else {
    process.stderr.write(`No deploymentBucket configured — skipping S3 cleanup\n`);
  }

  if (removeServerlessS3Artifacts) {
    if (deploymentBucket) {
      process.stderr.write(
        `Cleaning up legacy serverless S3 artifacts in bucket: ${deploymentBucket} (--remove-serverless-s3-artifacts)\n`
      );
      await s3Mgr.deleteServerlessLegacyArtifacts(deploymentBucket, service, stage, deploymentPrefix);
    } else {
      process.stderr.write(
        `--remove-serverless-s3-artifacts set but no deploymentBucket configured — skipping\n`
      );
    }
  }

  if (removeCfnStack) {
    process.stderr.write(`Checking for legacy CloudFormation stack (--remove-cfn-stack)\n`);
    await removeLegacyCloudFormationStack(region, service, stage);
  }

  process.stderr.write(`\nRemoval complete for service: ${service}\n`);
}

async function findFunctionsByTag(region: string, service: string): Promise<string[]> {
  const taggingClient = new ResourceGroupsTaggingAPIClient({
    region,
    maxAttempts: 3,
  });

  const functionArns: string[] = [];
  let paginationToken: string | undefined;

  do {
    const command = new GetResourcesCommand({
      TagFilters: [{ Key: 'ServerlessService', Values: [service] }],
      ResourceTypeFilters: ['lambda:function'],
      ...(paginationToken ? { PaginationToken: paginationToken } : {}),
    });

    let result;
    try {
      result = await taggingClient.send(command);
    } catch (err) {
      throw new Error(
        `Failed to query functions by tag for service ${service}: ${err.message}`
      );
    }

    for (const resource of result.ResourceTagMappingList ?? []) {
      if (resource.ResourceARN) functionArns.push(resource.ResourceARN);
    }

    paginationToken = result.PaginationToken ?? undefined;
  } while (paginationToken);

  return functionArns.map(arnToFunctionName);
}

async function removeFunctions(
  functionNames: string[],
  lambdaMgr: LambdaManager,
  cwMgr: CloudWatchManager
): Promise<void> {
  const results = await Promise.allSettled(
    functionNames.map(async (functionName) => {
      await lambdaMgr.deleteFunction(functionName);
      await cwMgr.deleteLogGroup(`/aws/lambda/${functionName}`);
    })
  );

  const failures = results.filter(
    (r): r is PromiseRejectedResult => r.status === 'rejected'
  );
  if (failures.length > 0) {
    throw new Error(
      `Failed to remove ${failures.length} of ${functionNames.length} function(s): ${failures
        .map((f) => (f.reason as Error).message)
        .join('; ')}`
    );
  }
}

async function removeLegacyCloudFormationStack(
  region: string,
  service: string,
  stage: string
): Promise<void> {
  const stackName = `${service}-${stage}`;
  const cfnClient = new CloudFormationClient({ region, maxAttempts: 3 });

  const stackExists = await cloudFormationStackExists(cfnClient, stackName);

  if (!stackExists) {
    process.stdout.write(`Service ${service} does not exist\n`);
    return;
  }

  process.stderr.write(`Deleting CloudFormation stack: ${stackName}\n`);

  try {
    await cfnClient.send(new DeleteStackCommand({ StackName: stackName }));
    process.stderr.write(`CloudFormation stack deletion initiated: ${stackName}\n`);
  } catch (err) {
    throw new Error(`Failed to delete CloudFormation stack ${stackName}: ${err.message}`);
  }
}

async function cloudFormationStackExists(
  cfnClient: CloudFormationClient,
  stackName: string
): Promise<boolean> {
  try {
    await cfnClient.send(new DescribeStacksCommand({ StackName: stackName }));
    return true;
  } catch (err) {
    if (err.message && (err.message as string).includes('does not exist')) {
      return false;
    }
    throw err;
  }
}

function arnToFunctionName(arn: string): string {
  const parts = arn.split(':');
  return parts[parts.length - 1];
}
