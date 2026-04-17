jest.mock('../../src/lib/config-loader');
jest.mock('../../src/lib/lambda-manager');
jest.mock('../../src/lib/cloudwatch-manager');
jest.mock('../../src/lib/s3-uploader');
jest.mock('../../src/lib/bundler');
jest.mock('fs');
jest.mock('dotenv');

import { loadConfig, resolveConfigPath } from '../../src/lib/config-loader';
import { LambdaManager } from '../../src/lib/lambda-manager';
import { CloudWatchManager } from '../../src/lib/cloudwatch-manager';
import { S3Uploader } from '../../src/lib/s3-uploader';
import { bundleAndZip } from '../../src/lib/bundler';
import fs from 'fs';
import dotenv from 'dotenv';
import deploy from '../../src/lib/deploy';

describe('deploy', () => {
  const WORKDIR = '/workspace';
  const BASE_CONFIG = {
    service: 'cf-abc123',
    stage: 'dev',
    provider: {
      region: 'us-east-1',
      runtime: 'nodejs20.x',
      deploymentBucket: 'my-bucket',
      deploymentPrefix: 'serverless',
      logRetentionInDays: 14,
    },
    functions: {},
  };

  let mockLambda: {
    createOrUpdateContainerFunction: jest.Mock;
    createOrUpdateZipFunction: jest.Mock;
    getFunctionUrl: jest.Mock;
  };
  let mockCW: { createLogGroupIfNotExists: jest.Mock };
  let mockS3: { uploadZip: jest.Mock };

  beforeEach(() => {
    jest.resetAllMocks();

    mockLambda = {
      createOrUpdateContainerFunction: jest.fn().mockResolvedValue(undefined),
      createOrUpdateZipFunction: jest.fn().mockResolvedValue(undefined),
      getFunctionUrl: jest.fn().mockResolvedValue(null),
    };
    mockCW = {
      createLogGroupIfNotExists: jest.fn().mockResolvedValue(undefined),
    };
    mockS3 = {
      uploadZip: jest.fn().mockResolvedValue(undefined),
    };

    jest.mocked(LambdaManager).mockImplementation(() => mockLambda as unknown as LambdaManager);
    jest.mocked(CloudWatchManager).mockImplementation(() => mockCW as unknown as CloudWatchManager);
    jest.mocked(S3Uploader).mockImplementation(() => mockS3 as unknown as S3Uploader);
    jest.mocked(bundleAndZip).mockResolvedValue({ zipFile: '/workspace/.cfnless/fn.zip' });
    jest.mocked(fs.existsSync).mockReturnValue(false);
    jest.mocked(dotenv.parse).mockReturnValue({});
  });

  it('deploys a container image function with correct log group name, function name, and merged tags', async () => {
    jest.mocked(loadConfig).mockReturnValue({
      ...BASE_CONFIG,
      functions: {
        api: {
          image: '123.dkr.ecr.us-east-1.amazonaws.com/repo:env-dep',
          role: 'arn:aws:iam::123:role/role',
          timeout: 30,
          memorySize: 2048,
          url: { authorizer: 'aws_iam', invokeMode: 'RESPONSE_STREAM' },
          tags: { DeploymentUid: 'abc123' },
        },
      },
    });

    await deploy(WORKDIR);

    expect(mockCW.createLogGroupIfNotExists).toHaveBeenCalledWith(
      '/aws/lambda/cf-abc123-dev-api',
      14
    );
    expect(mockLambda.createOrUpdateContainerFunction).toHaveBeenCalledWith(
      'cf-abc123-dev-api',
      expect.objectContaining({
        image: '123.dkr.ecr.us-east-1.amazonaws.com/repo:env-dep',
        role: 'arn:aws:iam::123:role/role',
        timeout: 30,
        memorySize: 2048,
        urlConfig: { authorizer: 'aws_iam', invokeMode: 'RESPONSE_STREAM' },
        tags: expect.objectContaining({
          ServerlessService: 'cf-abc123',
          DeploymentUid: 'abc123',
        }),
      })
    );
    expect(bundleAndZip).not.toHaveBeenCalled();
    expect(mockS3.uploadZip).not.toHaveBeenCalled();
  });

  it('bundles, uploads to the correct S3 key, and deploys a handler-based function with env vars from .env', async () => {
    jest.mocked(loadConfig).mockReturnValue({
      ...BASE_CONFIG,
      functions: {
        abc123: {
          handler: 'abc123.handler',
          role: 'arn:aws:iam::123:role/role',
          timeout: 30,
          memorySize: 1024,
          url: true,
          tags: {},
        },
      },
    });
    jest.mocked(fs.existsSync).mockReturnValueOnce(true);
    jest.mocked(fs.readFileSync).mockReturnValue('MY_VAR=hello\nOTHER=world\n');
    jest.mocked(dotenv.parse).mockReturnValue({ MY_VAR: 'hello', OTHER: 'world' });

    await deploy(WORKDIR);

    // runtimeToEsbuildTarget('nodejs20.x') => 'node20'
    expect(bundleAndZip).toHaveBeenCalledWith('abc123', WORKDIR, 'node20', 'cf-abc123-dev-abc123', undefined);
    expect(mockS3.uploadZip).toHaveBeenCalledWith(
      '/workspace/.cfnless/fn.zip',
      'my-bucket',
      'serverless/cf-abc123/dev/cf-abc123-dev-abc123.zip'
    );
    expect(mockLambda.createOrUpdateZipFunction).toHaveBeenCalledWith(
      'cf-abc123-dev-abc123',
      expect.objectContaining({
        handler: 'index.handler',
        s3Bucket: 'my-bucket',
        s3Key: 'serverless/cf-abc123/dev/cf-abc123-dev-abc123.zip',
        runtime: 'nodejs20.x',
        environment: { MY_VAR: 'hello', OTHER: 'world' },
      })
    );
  });

  it('strips the last dot-segment from handler for any export name, not just .handler', async () => {
    jest.mocked(loadConfig).mockReturnValue({
      ...BASE_CONFIG,
      functions: {
        hello: { handler: 'users.create', role: 'r', timeout: 30, memorySize: 512, tags: {} },
      },
    });

    await deploy(WORKDIR);

    // 'users.create' → file base is 'users', not 'users.create'
    expect(bundleAndZip).toHaveBeenCalledWith('users', WORKDIR, 'node20', 'cf-abc123-dev-hello', undefined);
  });

  it('strips the last dot-segment for nested path handlers', async () => {
    jest.mocked(loadConfig).mockReturnValue({
      ...BASE_CONFIG,
      functions: {
        hello: { handler: 'src/users.create', role: 'r', timeout: 30, memorySize: 512, tags: {} },
      },
    });

    await deploy(WORKDIR);

    expect(bundleAndZip).toHaveBeenCalledWith('src/users', WORKDIR, 'node20', 'cf-abc123-dev-hello', undefined);
  });

  it('merges function-level environment over .env vars, with function vars taking precedence', async () => {
    jest.mocked(loadConfig).mockReturnValue({
      ...BASE_CONFIG,
      functions: {
        api: {
          handler: 'api.handler',
          role: 'r',
          timeout: 30,
          memorySize: 512,
          environment: { OVERRIDE: 'func-value', FUNC_ONLY: 'yes' },
          tags: {},
        },
      },
    });
    jest.mocked(fs.existsSync).mockReturnValueOnce(true);
    jest.mocked(fs.readFileSync).mockReturnValue('');
    jest.mocked(dotenv.parse).mockReturnValue({ OVERRIDE: 'env-value', DOT_ENV_ONLY: 'present' });

    await deploy(WORKDIR);

    expect(mockLambda.createOrUpdateZipFunction).toHaveBeenCalledWith(
      'cf-abc123-dev-api',
      expect.objectContaining({
        environment: {
          DOT_ENV_ONLY: 'present',
          OVERRIDE: 'func-value',   // function-level wins
          FUNC_ONLY: 'yes',
        },
      })
    );
  });

  it('uses function-level runtime for the Lambda runtime when set', async () => {
    jest.mocked(loadConfig).mockReturnValue({
      ...BASE_CONFIG,
      functions: {
        legacy: {
          handler: 'legacy.handler',
          role: 'r',
          timeout: 30,
          memorySize: 512,
          runtime: 'nodejs18.x',
          tags: {},
        },
      },
    });

    await deploy(WORKDIR);

    expect(mockLambda.createOrUpdateZipFunction).toHaveBeenCalledWith(
      'cf-abc123-dev-legacy',
      expect.objectContaining({ runtime: 'nodejs18.x' })
    );
  });

  it('uses function-level runtime as the esbuild target when set', async () => {
    jest.mocked(loadConfig).mockReturnValue({
      ...BASE_CONFIG,
      functions: {
        legacy: {
          handler: 'legacy.handler',
          role: 'r',
          timeout: 30,
          memorySize: 512,
          runtime: 'nodejs18.x',
          tags: {},
        },
      },
    });

    await deploy(WORKDIR);

    // runtimeToEsbuildTarget('nodejs18.x') => 'node18'
    expect(bundleAndZip).toHaveBeenCalledWith('legacy', WORKDIR, 'node18', 'cf-abc123-dev-legacy', undefined);
  });

  it('falls back to provider runtime when function-level runtime is not set', async () => {
    jest.mocked(loadConfig).mockReturnValue({
      ...BASE_CONFIG,
      functions: {
        api: { handler: 'api.handler', role: 'r', timeout: 30, memorySize: 512, tags: {} },
      },
    });

    await deploy(WORKDIR);

    expect(bundleAndZip).toHaveBeenCalledWith('api', WORKDIR, 'node20', 'cf-abc123-dev-api', undefined);
    expect(mockLambda.createOrUpdateZipFunction).toHaveBeenCalledWith(
      'cf-abc123-dev-api',
      expect.objectContaining({ runtime: 'nodejs20.x' })
    );
  });

  it('throws with function key name when function has neither image, handler, nor artifact', async () => {
    jest.mocked(loadConfig).mockReturnValue({
      ...BASE_CONFIG,
      functions: {
        broken: { role: 'r', timeout: 30, memorySize: 512, url: true, tags: {} },
      },
    });

    await expect(deploy(WORKDIR)).rejects.toThrow('neither "image", "handler", nor "artifact"/"package.artifact"');
  });

  it('exits early with no AWS calls when no functions are defined', async () => {
    jest.mocked(loadConfig).mockReturnValue({ ...BASE_CONFIG, functions: {} });

    await deploy(WORKDIR);

    expect(mockLambda.createOrUpdateContainerFunction).not.toHaveBeenCalled();
    expect(mockLambda.createOrUpdateZipFunction).not.toHaveBeenCalled();
    expect(mockCW.createLogGroupIfNotExists).not.toHaveBeenCalled();
  });

  it('deploys multiple functions in parallel (Promise.all)', async () => {
    jest.mocked(loadConfig).mockReturnValue({
      ...BASE_CONFIG,
      functions: {
        api: { image: 'img:tag', role: 'r', timeout: 30, memorySize: 1024, url: {}, tags: {} },
        abc123: { image: 'img2:tag', role: 'r', timeout: 30, memorySize: 1024, url: {}, tags: {} },
      },
    });

    await deploy(WORKDIR);

    expect(mockLambda.createOrUpdateContainerFunction).toHaveBeenCalledTimes(2);
    expect(mockCW.createLogGroupIfNotExists).toHaveBeenCalledTimes(2);
  });

  it('bundles two handler functions with distinct zip names and S3 keys', async () => {
    // Prior impl named zips after the handler basename, which would collide if two
    // functions shared a handler file. Names must derive from the unique functionName.
    jest.mocked(loadConfig).mockReturnValue({
      ...BASE_CONFIG,
      functions: {
        alpha: { handler: 'shared.handler', role: 'r', timeout: 30, memorySize: 512, url: true, tags: {} },
        beta: { handler: 'shared.handler', role: 'r', timeout: 30, memorySize: 512, url: true, tags: {} },
      },
    });
    jest.mocked(bundleAndZip).mockImplementation(async (_h, _w, _t, functionName) => ({
      zipFile: `/workspace/.cfnless/${functionName}.zip`,
    }));

    await deploy(WORKDIR);

    expect(bundleAndZip).toHaveBeenCalledWith('shared', WORKDIR, 'node20', 'cf-abc123-dev-alpha', undefined);
    expect(bundleAndZip).toHaveBeenCalledWith('shared', WORKDIR, 'node20', 'cf-abc123-dev-beta', undefined);
    expect(mockS3.uploadZip).toHaveBeenCalledWith(
      '/workspace/.cfnless/cf-abc123-dev-alpha.zip',
      'my-bucket',
      'serverless/cf-abc123/dev/cf-abc123-dev-alpha.zip'
    );
    expect(mockS3.uploadZip).toHaveBeenCalledWith(
      '/workspace/.cfnless/cf-abc123-dev-beta.zip',
      'my-bucket',
      'serverless/cf-abc123/dev/cf-abc123-dev-beta.zip'
    );
  });

  it('uses custom deploymentPrefix in the S3 key when provider.deploymentPrefix is set', async () => {
    // Overrides the default "serverless" prefix. Exercised by the config-loader test
    // separately; here we confirm it actually reaches the s3Key construction.
    jest.mocked(loadConfig).mockReturnValue({
      ...BASE_CONFIG,
      provider: { ...BASE_CONFIG.provider, deploymentPrefix: 'cfnless' },
      functions: {
        abc123: { handler: 'abc123.handler', role: 'r', timeout: 30, memorySize: 1024, url: true, tags: {} },
      },
    });
    jest.mocked(fs.existsSync).mockReturnValueOnce(true);

    await deploy(WORKDIR);

    expect(mockS3.uploadZip).toHaveBeenCalledWith(
      '/workspace/.cfnless/fn.zip',
      'my-bucket',
      'cfnless/cf-abc123/dev/cf-abc123-dev-abc123.zip'
    );
  });

  it('normalizes url:true to empty urlConfig object for handler functions', async () => {
    jest.mocked(loadConfig).mockReturnValue({
      ...BASE_CONFIG,
      functions: {
        api: { image: 'img:tag', role: 'r', timeout: 30, memorySize: 1024, url: true, tags: {} },
      },
    });

    await deploy(WORKDIR);

    expect(mockLambda.createOrUpdateContainerFunction).toHaveBeenCalledWith(
      'cf-abc123-dev-api',
      expect.objectContaining({ urlConfig: {} })
    );
  });

  it('uses default timeout and memorySize when not specified in function config', async () => {
    jest.mocked(loadConfig).mockReturnValue({
      ...BASE_CONFIG,
      functions: {
        api: { image: 'img:tag', role: 'r', url: {}, tags: {} },
      },
    });

    await deploy(WORKDIR);

    expect(mockLambda.createOrUpdateContainerFunction).toHaveBeenCalledWith(
      'cf-abc123-dev-api',
      expect.objectContaining({ timeout: 30, memorySize: 1024 })
    );
  });

  it('throws before bundling when deploymentBucket is null and a handler function is defined', async () => {
    // A zip function requires a deployment bucket — fail early with a clear message
    // rather than a cryptic S3 SDK error deep in the upload step.
    jest.mocked(loadConfig).mockReturnValue({
      ...BASE_CONFIG,
      provider: { ...BASE_CONFIG.provider, deploymentBucket: null },
      functions: {
        worker: { handler: 'worker.handler', role: 'r', timeout: 30, memorySize: 512, url: true, tags: {} },
      },
    });

    await expect(deploy(WORKDIR)).rejects.toThrow('Deployment bucket name is required');
    expect(bundleAndZip).not.toHaveBeenCalled();
  });

  it('passes urlConfig:null to lambda manager when url is not set — no function URL created', async () => {
    // Covers the _upsertFunctionUrl early-return fix: omitting url: should not create a public URL.
    jest.mocked(loadConfig).mockReturnValue({
      ...BASE_CONFIG,
      functions: {
        api: { image: 'img:tag', role: 'r', timeout: 30, memorySize: 1024, tags: {} },
      },
    });

    await deploy(WORKDIR);

    expect(mockLambda.createOrUpdateContainerFunction).toHaveBeenCalledWith(
      'cf-abc123-dev-api',
      expect.objectContaining({ urlConfig: null })
    );
  });

  it('passes configPath to resolveConfigPath', async () => {
    jest.mocked(loadConfig).mockReturnValue(BASE_CONFIG);
    jest.mocked(resolveConfigPath).mockReturnValue('/workspace/custom.yml');
    await deploy('/workspace', 'custom.yml');
    expect(resolveConfigPath).toHaveBeenCalledWith('/workspace', 'custom.yml');
    expect(loadConfig).toHaveBeenCalledWith('/workspace/custom.yml');
  });

  it('filters functions when functionFilter is provided', async () => {
    jest.mocked(loadConfig).mockReturnValue({
      ...BASE_CONFIG,
      functions: {
        api: { image: 'img:tag', role: 'r', timeout: 30, memorySize: 1024, url: {}, tags: {} },
        abc123: { image: 'img2:tag', role: 'r', timeout: 30, memorySize: 1024, url: {}, tags: {} },
      },
    });
    jest.mocked(resolveConfigPath).mockReturnValue('/workspace/cfnless.yml');

    await deploy('/workspace', null, 'api');

    expect(mockLambda.createOrUpdateContainerFunction).toHaveBeenCalledTimes(1);
    expect(mockLambda.createOrUpdateContainerFunction).toHaveBeenCalledWith(
      'cf-abc123-dev-api',
      expect.anything()
    );
  });

  it('throws when functionFilter specifies a non-existent function', async () => {
    jest.mocked(loadConfig).mockReturnValue({
      ...BASE_CONFIG,
      functions: {
        api: { image: 'img:tag', role: 'r', timeout: 30, memorySize: 1024, url: {}, tags: {} },
      },
    });
    jest.mocked(resolveConfigPath).mockReturnValue('/workspace/cfnless.yml');

    await expect(deploy('/workspace', null, 'unknown')).rejects.toThrow('Function "unknown" not found in config');
  });

  it('skips bundling and uploads the pre-built artifact directly when artifact is set', async () => {
    jest.mocked(loadConfig).mockReturnValue({
      ...BASE_CONFIG,
      functions: {
        api: { artifact: 'dist/api.zip', role: 'r', timeout: 30, memorySize: 512, url: true, tags: {} },
      },
    });

    await deploy(WORKDIR);

    expect(bundleAndZip).not.toHaveBeenCalled();
    expect(mockS3.uploadZip).toHaveBeenCalledWith(
      '/workspace/dist/api.zip',
      'my-bucket',
      'serverless/cf-abc123/dev/cf-abc123-dev-api.zip'
    );
    expect(mockLambda.createOrUpdateZipFunction).toHaveBeenCalledWith(
      'cf-abc123-dev-api',
      expect.objectContaining({ handler: 'index.handler', runtime: 'nodejs20.x' })
    );
  });

  it('uses funcConfig.handler as Lambda handler when package.artifact and handler are both set', async () => {
    jest.mocked(loadConfig).mockReturnValue({
      ...BASE_CONFIG,
      functions: {
        mailer: {
          handler: 'mailer.handler',
          package: { artifact: 'dist/mailer.zip' },
          role: 'r', timeout: 30, memorySize: 256, tags: {},
        },
      },
    });

    await deploy(WORKDIR);

    expect(bundleAndZip).not.toHaveBeenCalled();
    expect(mockLambda.createOrUpdateZipFunction).toHaveBeenCalledWith(
      'cf-abc123-dev-mailer',
      expect.objectContaining({ handler: 'mailer.handler' })
    );
  });

  it('throws before uploading when deploymentBucket is null and artifact is set', async () => {
    jest.mocked(loadConfig).mockReturnValue({
      ...BASE_CONFIG,
      provider: { ...BASE_CONFIG.provider, deploymentBucket: null },
      functions: {
        api: { artifact: 'dist/api.zip', role: 'r', timeout: 30, memorySize: 512, url: true, tags: {} },
      },
    });

    await expect(deploy(WORKDIR)).rejects.toThrow('Deployment bucket name is required');
    expect(bundleAndZip).not.toHaveBeenCalled();
    expect(mockS3.uploadZip).not.toHaveBeenCalled();
  });

  it('passes custom.esbuild options (exclude, minify, sourcemap, tsconfig) to bundleAndZip', async () => {
    jest.mocked(loadConfig).mockReturnValue({
      ...BASE_CONFIG,
      functions: {
        api: { handler: 'api.handler', role: 'r', timeout: 30, memorySize: 512, url: true, tags: {} },
      },
      custom: { esbuild: { minify: true, sourcemap: true, exclude: ['sharp'], tsconfig: 'tsconfig.build.json' } },
    });

    await deploy(WORKDIR);

    expect(bundleAndZip).toHaveBeenCalledWith(
      'api', WORKDIR, 'node20', 'cf-abc123-dev-api',
      { minify: true, sourcemap: true, exclude: ['sharp'], tsconfig: 'tsconfig.build.json' }
    );
  });

  it('deploys using Serverless Framework-compatible package.artifact field', async () => {
    jest.mocked(loadConfig).mockReturnValue({
      ...BASE_CONFIG,
      functions: {
        api: { package: { artifact: 'dist/api.zip' }, role: 'r', timeout: 30, memorySize: 512, url: true, tags: {} },
      },
    });

    await deploy(WORKDIR);

    expect(bundleAndZip).not.toHaveBeenCalled();
    expect(mockS3.uploadZip).toHaveBeenCalledWith(
      '/workspace/dist/api.zip',
      'my-bucket',
      'serverless/cf-abc123/dev/cf-abc123-dev-api.zip'
    );
  });

  it('prefers package.artifact over bare artifact when both are set', async () => {
    jest.mocked(loadConfig).mockReturnValue({
      ...BASE_CONFIG,
      functions: {
        api: {
          artifact: 'old/path.zip',
          package: { artifact: 'dist/correct.zip' },
          role: 'r', timeout: 30, memorySize: 512, tags: {},
        },
      },
    });

    await deploy(WORKDIR);

    expect(mockS3.uploadZip).toHaveBeenCalledWith(
      '/workspace/dist/correct.zip',
      expect.any(String),
      expect.any(String)
    );
  });
});
