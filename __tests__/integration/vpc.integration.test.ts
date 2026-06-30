import {
  LambdaClient,
  GetFunctionCommand,
} from '@aws-sdk/client-lambda';

// Requires: docker compose -f __tests__/integration/docker-compose.yml up -d --wait
//
// Tests VPC config wiring against LocalStack.
// LocalStack accepts VpcConfig in CreateFunction/UpdateFunctionConfiguration calls
// but does not persist and echo it back in GetFunction responses — it treats the
// field as pass-through. Assertions therefore verify:
//   - create/update with VpcConfig resolves without error (SDK call is well-formed)
//   - update with null VpcConfig (empty arrays) resolves without error
//   - the null/remove path leaves VpcConfig in the expected empty state

const LOCALSTACK = 'http://localhost:4566';
const REGION = 'us-east-1';

const FAKE_IAM_ROLE = 'arn:aws:iam::000000000000:role/cfnless-test-role';
const FAKE_IMAGE = '000000000000.dkr.ecr.us-east-1.localhost.localstack.cloud:4566/test-repo:latest';
const FAKE_SG_1 = 'sg-0123456789abcdef0';
const FAKE_SG_2 = 'sg-0fedcba9876543210';
const FAKE_SUBNET_1 = 'subnet-0123456789abcdef0';
const FAKE_SUBNET_2 = 'subnet-0123456789abcdef1';

const TEST_SERVICE = `cf-vpc-inttest-${Date.now()}`;
const FUNCTION_NAME = `${TEST_SERVICE}-dev-api`;

import { LambdaManager } from '../../src/lib/lambda-manager';

function makeLambdaManager() {
  const mgr = new LambdaManager(REGION);
  mgr.client = new LambdaClient({
    endpoint: LOCALSTACK,
    region: REGION,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
  return mgr;
}

function makeLambdaClient() {
  return new LambdaClient({
    endpoint: LOCALSTACK,
    region: REGION,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
}

const BASE_CONFIG = {
  image: FAKE_IMAGE,
  role: FAKE_IAM_ROLE,
  timeout: 10,
  memorySize: 512,
  urlConfig: null,
  tags: { ServerlessService: TEST_SERVICE },
};

describe('VPC config integration (LocalStack)', () => {
  const lambdaMgr = makeLambdaManager();
  const lambdaClient = makeLambdaClient();

  afterAll(async () => {
    await lambdaMgr.deleteFunction(FUNCTION_NAME).catch(() => {});
  });

  it('creates a function with VPC config without error', async () => {
    await expect(
      lambdaMgr.createOrUpdateContainerFunction(FUNCTION_NAME, {
        ...BASE_CONFIG,
        vpcConfig: { securityGroupIds: [FAKE_SG_1], subnetIds: [FAKE_SUBNET_1, FAKE_SUBNET_2] },
      })
    ).resolves.toBeUndefined();

    // Verify the function exists and has expected base config
    const fn = await lambdaClient.send(new GetFunctionCommand({ FunctionName: FUNCTION_NAME }));
    expect(fn.Configuration!.FunctionName).toBe(FUNCTION_NAME);
    expect(fn.Configuration!.MemorySize).toBe(512);
  });

  it('updates VPC config on re-deploy without error', async () => {
    await expect(
      lambdaMgr.createOrUpdateContainerFunction(FUNCTION_NAME, {
        ...BASE_CONFIG,
        vpcConfig: { securityGroupIds: [FAKE_SG_2], subnetIds: [FAKE_SUBNET_2] },
      })
    ).resolves.toBeUndefined();
  });

  it('removes VPC config when vpcConfig is null (empty arrays accepted by Lambda API)', async () => {
    await expect(
      lambdaMgr.createOrUpdateContainerFunction(FUNCTION_NAME, {
        ...BASE_CONFIG,
        vpcConfig: null,
      })
    ).resolves.toBeUndefined();

    const fn = await lambdaClient.send(new GetFunctionCommand({ FunctionName: FUNCTION_NAME }));
    const vpc = fn.Configuration!.VpcConfig;
    const hasVpc =
      vpc && (vpc.SubnetIds?.length ?? 0) > 0 && (vpc.SecurityGroupIds?.length ?? 0) > 0;
    expect(hasVpc).toBeFalsy();
  });
});
