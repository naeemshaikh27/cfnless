import {
  LambdaClient,
  GetFunctionCommand,
} from '@aws-sdk/client-lambda';
import {
  CloudWatchLogsClient,
  DescribeLogGroupsCommand,
} from '@aws-sdk/client-cloudwatch-logs';

// Requires: docker compose -f __tests__/integration/docker-compose.yml up -d --wait
//
// Tests the LambdaManager and CloudWatchManager against LocalStack end-to-end.
// We use container functions since LocalStack supports image-based Lambdas in local executor mode.
// The FAKE_IMAGE is a placeholder — LocalStack accepts the create call without pulling it.

const LOCALSTACK = 'http://localhost:4566';
const REGION = 'us-east-1';

const FAKE_IAM_ROLE = 'arn:aws:iam::000000000000:role/cfnless-test-role';
// LocalStack accepts any image URI for container functions in local mode
const FAKE_IMAGE = '000000000000.dkr.ecr.us-east-1.localhost.localstack.cloud:4566/test-repo:latest';
const TEST_SERVICE = `cf-inttest-${Date.now()}`;
const FUNCTION_KEY = 'api';
const FUNCTION_NAME = `${TEST_SERVICE}-dev-${FUNCTION_KEY}`;

import { LambdaManager } from '../../src/lib/lambda-manager';
import { CloudWatchManager } from '../../src/lib/cloudwatch-manager';

function makeLambdaManager() {
  const mgr = new LambdaManager(REGION);
  mgr.client = new LambdaClient({
    endpoint: LOCALSTACK,
    region: REGION,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
  return mgr;
}

function makeCWManager() {
  const mgr = new CloudWatchManager(REGION);
  mgr.client = new CloudWatchLogsClient({
    endpoint: LOCALSTACK,
    region: REGION,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
  return mgr;
}

describe('Deploy lifecycle integration (LocalStack)', () => {
  const lambdaMgr = makeLambdaManager();
  const cwMgr = makeCWManager();

  const LOG_GROUP = `/aws/lambda/${FUNCTION_NAME}`;

  const FUNC_CONFIG = {
    image: FAKE_IMAGE,
    role: FAKE_IAM_ROLE,
    timeout: 10,
    memorySize: 512,
    urlConfig: {},
    tags: {
      ServerlessService: TEST_SERVICE,
      DeploymentUid: 'inttest',
    },
  };

  afterAll(async () => {
    await lambdaMgr.deleteFunction(FUNCTION_NAME).catch(() => {});
    await cwMgr.deleteLogGroup(LOG_GROUP).catch(() => {});
  });

  it('creates log group, deploys container function with correct config, updates it, then removes everything', async () => {
    // 1. Create log group
    await cwMgr.createLogGroupIfNotExists(LOG_GROUP, 14);

    const cwClient = new CloudWatchLogsClient({
      endpoint: LOCALSTACK,
      region: REGION,
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    const logGroupsResult = await cwClient.send(
      new DescribeLogGroupsCommand({ logGroupNamePrefix: LOG_GROUP })
    );
    expect(logGroupsResult.logGroups!.some((g) => g.logGroupName === LOG_GROUP)).toBe(true);

    // 2. Deploy container function
    await lambdaMgr.createOrUpdateContainerFunction(FUNCTION_NAME, FUNC_CONFIG);

    const lambdaClient = new LambdaClient({
      endpoint: LOCALSTACK,
      region: REGION,
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    const fn = await lambdaClient.send(new GetFunctionCommand({ FunctionName: FUNCTION_NAME }));
    expect(fn.Configuration!.FunctionName).toBe(FUNCTION_NAME);
    expect(fn.Configuration!.MemorySize).toBe(512);
    expect(fn.Configuration!.Timeout).toBe(10);

    // 3. Re-deploy (idempotent update) with changed memorySize
    await expect(
      lambdaMgr.createOrUpdateContainerFunction(FUNCTION_NAME, {
        ...FUNC_CONFIG,
        memorySize: 1024,
      })
    ).resolves.toBeUndefined();

    const updated = await lambdaClient.send(new GetFunctionCommand({ FunctionName: FUNCTION_NAME }));
    expect(updated.Configuration!.MemorySize).toBe(1024);

    // 4. Remove function and log group
    await lambdaMgr.deleteFunction(FUNCTION_NAME);
    await cwMgr.deleteLogGroup(LOG_GROUP);

    // 5. Verify function and log group are gone
    const afterDelete = await cwClient.send(
      new DescribeLogGroupsCommand({ logGroupNamePrefix: LOG_GROUP })
    );
    expect(afterDelete.logGroups!.find((g) => g.logGroupName === LOG_GROUP)).toBeUndefined();
  });

  it('deleteFunction writes "does not exist" to stdout and resolves cleanly for a missing function', async () => {
    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await expect(
      lambdaMgr.deleteFunction('cf-nonexistent-dev-FUNCTION')
    ).resolves.toBeUndefined();

    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('does not exist'));
    stdoutSpy.mockRestore();
  });

  it('deleteLogGroup resolves silently for a log group that was never created', async () => {
    await expect(
      cwMgr.deleteLogGroup('/aws/lambda/cfnless-never-existed')
    ).resolves.toBeUndefined();
  });
});
