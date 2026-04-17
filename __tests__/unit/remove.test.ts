jest.mock('../../src/lib/config-loader');
jest.mock('../../src/lib/lambda-manager');
jest.mock('../../src/lib/cloudwatch-manager');
jest.mock('../../src/lib/s3-uploader');
jest.mock('@aws-sdk/client-resource-groups-tagging-api');
jest.mock('@aws-sdk/client-cloudformation');

import { loadConfig, resolveConfigPath } from '../../src/lib/config-loader';
import { LambdaManager } from '../../src/lib/lambda-manager';
import { CloudWatchManager } from '../../src/lib/cloudwatch-manager';
import { S3Uploader } from '../../src/lib/s3-uploader';
import {
  ResourceGroupsTaggingAPIClient,
  GetResourcesCommand,
} from '@aws-sdk/client-resource-groups-tagging-api';
import {
  CloudFormationClient,
  DeleteStackCommand,
  DescribeStacksCommand,
} from '@aws-sdk/client-cloudformation';
import remove from '../../src/lib/remove';

describe('remove', () => {
  let mockLambda: { deleteFunction: jest.Mock };
  let mockCW: { deleteLogGroup: jest.Mock };
  let mockS3: { deleteServiceZips: jest.Mock; deleteServerlessLegacyArtifacts: jest.Mock };
  let mockTaggingSend: jest.Mock;
  let mockCFNSend: jest.Mock;

  const BASE_CONFIG = {
    service: 'cf-abc123',
    stage: 'dev',
    provider: { region: 'us-east-1', deploymentPrefix: 'serverless' },
    functions: {},
  };

  const FUNCTION_ARN = 'arn:aws:lambda:us-east-1:123:function:cf-abc123-dev-api';

  beforeEach(() => {
    jest.resetAllMocks();

    mockLambda = {
      deleteFunction: jest.fn().mockResolvedValue(undefined),
    };
    mockCW = {
      deleteLogGroup: jest.fn().mockResolvedValue(undefined),
    };
    mockS3 = {
      deleteServiceZips: jest.fn().mockResolvedValue(undefined),
      deleteServerlessLegacyArtifacts: jest.fn().mockResolvedValue(undefined),
    };
    mockTaggingSend = jest.fn();
    mockCFNSend = jest.fn();

    jest.mocked(LambdaManager).mockImplementation(() => mockLambda as unknown as LambdaManager);
    jest.mocked(CloudWatchManager).mockImplementation(() => mockCW as unknown as CloudWatchManager);
    jest.mocked(S3Uploader).mockImplementation(() => mockS3 as unknown as S3Uploader);
    jest.mocked(ResourceGroupsTaggingAPIClient).mockImplementation(() => ({ send: mockTaggingSend }) as unknown as ResourceGroupsTaggingAPIClient);
    jest.mocked(CloudFormationClient).mockImplementation(() => ({ send: mockCFNSend }) as unknown as CloudFormationClient);

    jest.mocked(loadConfig).mockReturnValue(BASE_CONFIG as ReturnType<typeof loadConfig>);
    jest.mocked(resolveConfigPath).mockImplementation((workdir: string, configPath: string | null) => {
      if (configPath) {
        if (configPath.startsWith('/')) return configPath;
        return `${workdir}/${configPath}`;
      }
      return `${workdir}/cfnless.yml`;
    });
  });

  it('finds functions by ServerlessService tag and deletes them with their log groups', async () => {
    mockTaggingSend.mockResolvedValueOnce({
      ResourceTagMappingList: [{ ResourceARN: FUNCTION_ARN }],
      PaginationToken: null,
    });

    await remove('/workspace', null);

    // AWS SDK v3: constructor args are in Command.mock.calls[0][0] when class is mocked
    expect(jest.mocked(GetResourcesCommand).mock.calls[0][0]).toMatchObject({
      TagFilters: [{ Key: 'ServerlessService', Values: ['cf-abc123'] }],
      ResourceTypeFilters: ['lambda:function'],
    });
    expect(mockLambda.deleteFunction).toHaveBeenCalledWith('cf-abc123-dev-api');
    expect(mockCW.deleteLogGroup).toHaveBeenCalledWith('/aws/lambda/cf-abc123-dev-api');
  });

  it('paginates through all tagged functions across multiple pages', async () => {
    const arn2 = 'arn:aws:lambda:us-east-1:123:function:cf-abc123-dev-abc123';
    mockTaggingSend
      .mockResolvedValueOnce({
        ResourceTagMappingList: [{ ResourceARN: FUNCTION_ARN }],
        PaginationToken: 'token1',
      })
      .mockResolvedValueOnce({
        ResourceTagMappingList: [{ ResourceARN: arn2 }],
        PaginationToken: null,
      });

    await remove('/workspace', null);

    expect(mockTaggingSend).toHaveBeenCalledTimes(2);
    expect(mockLambda.deleteFunction).toHaveBeenCalledTimes(2);
    expect(mockLambda.deleteFunction).toHaveBeenCalledWith('cf-abc123-dev-api');
    expect(mockLambda.deleteFunction).toHaveBeenCalledWith('cf-abc123-dev-abc123');
  });

  it('does not touch CloudFormation by default when no --remove-cfn-stack flag is set', async () => {
    mockTaggingSend.mockResolvedValueOnce({ ResourceTagMappingList: [], PaginationToken: null });

    await remove('/workspace', null);

    expect(mockLambda.deleteFunction).not.toHaveBeenCalled();
    expect(mockCFNSend).not.toHaveBeenCalled();
  });

  it('cleans up S3 artifacts even when no tagged functions are found', async () => {
    // S3 zips can outlive their lambdas (half-cleaned state); always attempt S3 cleanup
    // when deploymentBucket is configured, regardless of whether functions exist.
    jest.mocked(loadConfig).mockReturnValue({
      ...BASE_CONFIG,
      provider: { ...BASE_CONFIG.provider, deploymentBucket: 'my-bucket' },
    } as ReturnType<typeof loadConfig>);
    mockTaggingSend.mockResolvedValueOnce({ ResourceTagMappingList: [], PaginationToken: null });

    await remove('/workspace', null);

    expect(mockLambda.deleteFunction).not.toHaveBeenCalled();
    expect(mockS3.deleteServiceZips).toHaveBeenCalledWith('my-bucket', 'cf-abc123', 'dev', 'serverless');
  });

  it('attempts CFN stack deletion when --remove-cfn-stack is set regardless of tagged-function presence', async () => {
    // --remove-cfn-stack is unconditional: the user is saying "also try to nuke the stack".
    jest.mocked(loadConfig).mockReturnValue({
      ...BASE_CONFIG,
      provider: { ...BASE_CONFIG.provider, deploymentBucket: 'my-bucket' },
    } as ReturnType<typeof loadConfig>);
    mockTaggingSend.mockResolvedValueOnce({
      ResourceTagMappingList: [{ ResourceARN: FUNCTION_ARN }],
      PaginationToken: null,
    });
    mockCFNSend
      .mockResolvedValueOnce({ Stacks: [{ StackName: 'cf-abc123-dev' }] })
      .mockResolvedValueOnce({});

    await remove('/workspace', null, true);

    expect(mockLambda.deleteFunction).toHaveBeenCalled();
    expect(mockS3.deleteServiceZips).toHaveBeenCalled();
    expect(mockCFNSend.mock.calls[1][0]).toBeInstanceOf(DeleteStackCommand);
  });

  it('deletes legacy CloudFormation stack when --remove-cfn-stack flag is set and stack exists', async () => {
    mockTaggingSend.mockResolvedValueOnce({ ResourceTagMappingList: [], PaginationToken: null });
    mockCFNSend
      .mockResolvedValueOnce({ Stacks: [{ StackName: 'cf-abc123-dev' }] }) // DescribeStacks
      .mockResolvedValueOnce({});                                            // DeleteStack

    await remove('/workspace', null, true);

    expect(mockCFNSend.mock.calls[0][0]).toBeInstanceOf(DescribeStacksCommand);
    expect(mockCFNSend.mock.calls[1][0]).toBeInstanceOf(DeleteStackCommand);
  });

  it('with --remove-serverless-s3-artifacts, cleans legacy serverless S3 prefix when bucket is configured', async () => {
    jest.mocked(loadConfig).mockReturnValue({
      ...BASE_CONFIG,
      provider: { ...BASE_CONFIG.provider, deploymentBucket: 'my-bucket' },
    } as ReturnType<typeof loadConfig>);
    mockTaggingSend.mockResolvedValueOnce({ ResourceTagMappingList: [], PaginationToken: null });

    await remove('/workspace', null, false, true);

    expect(mockS3.deleteServerlessLegacyArtifacts).toHaveBeenCalledWith('my-bucket', 'cf-abc123', 'dev', 'serverless');
    // Default flat cleanup still runs too
    expect(mockS3.deleteServiceZips).toHaveBeenCalledWith('my-bucket', 'cf-abc123', 'dev', 'serverless');
  });

  it('with --remove-serverless-s3-artifacts but no deploymentBucket, skips legacy S3 cleanup with warning', async () => {
    mockTaggingSend.mockResolvedValueOnce({ ResourceTagMappingList: [], PaginationToken: null });
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await remove('/workspace', null, false, true);

    expect(mockS3.deleteServerlessLegacyArtifacts).not.toHaveBeenCalled();
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('--remove-serverless-s3-artifacts set but no deploymentBucket')
    );
    stderrSpy.mockRestore();
  });

  it('without --remove-serverless-s3-artifacts, legacy S3 cleanup is not triggered', async () => {
    jest.mocked(loadConfig).mockReturnValue({
      ...BASE_CONFIG,
      provider: { ...BASE_CONFIG.provider, deploymentBucket: 'my-bucket' },
    } as ReturnType<typeof loadConfig>);
    mockTaggingSend.mockResolvedValueOnce({ ResourceTagMappingList: [], PaginationToken: null });

    await remove('/workspace', null);

    expect(mockS3.deleteServerlessLegacyArtifacts).not.toHaveBeenCalled();
  });

  it('combined --remove-cfn-stack --remove-serverless-s3-artifacts runs stack delete and legacy S3 cleanup', async () => {
    jest.mocked(loadConfig).mockReturnValue({
      ...BASE_CONFIG,
      provider: { ...BASE_CONFIG.provider, deploymentBucket: 'my-bucket' },
    } as ReturnType<typeof loadConfig>);
    mockTaggingSend.mockResolvedValueOnce({ ResourceTagMappingList: [], PaginationToken: null });
    mockCFNSend
      .mockResolvedValueOnce({ Stacks: [{ StackName: 'cf-abc123-dev' }] })
      .mockResolvedValueOnce({});

    await remove('/workspace', null, true, true);

    expect(mockS3.deleteServerlessLegacyArtifacts).toHaveBeenCalledWith('my-bucket', 'cf-abc123', 'dev', 'serverless');
    expect(mockCFNSend.mock.calls[1][0]).toBeInstanceOf(DeleteStackCommand);
  });

  it('with --remove-cfn-stack, also deletes CFN stack even when tagged functions exist', async () => {
    // --remove-cfn-stack is additive: both SDK-deployed functions and any legacy stack get cleaned up.
    mockTaggingSend.mockResolvedValueOnce({
      ResourceTagMappingList: [{ ResourceARN: FUNCTION_ARN }],
      PaginationToken: null,
    });
    mockCFNSend
      .mockResolvedValueOnce({ Stacks: [{ StackName: 'cf-abc123-dev' }] })
      .mockResolvedValueOnce({});

    await remove('/workspace', null, true);

    expect(mockLambda.deleteFunction).toHaveBeenCalledWith('cf-abc123-dev-api');
    expect(mockCFNSend.mock.calls[1][0]).toBeInstanceOf(DeleteStackCommand);
  });

  it('writes "does not exist" to stdout when --remove-cfn-stack set and CFN stack is absent', async () => {
    mockTaggingSend.mockResolvedValueOnce({ ResourceTagMappingList: [], PaginationToken: null });
    const doesNotExist = new Error('Stack cf-abc123-dev does not exist');
    mockCFNSend.mockRejectedValueOnce(doesNotExist);

    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await remove('/workspace', null, true);

    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('does not exist'));
    stdoutSpy.mockRestore();
  });

  it('resolves relative --config path against workdir', async () => {
    mockTaggingSend.mockResolvedValueOnce({ ResourceTagMappingList: [], PaginationToken: null });

    await remove('/workspace', 'serverless.js');

    expect(loadConfig).toHaveBeenCalledWith('/workspace/serverless.js');
  });

  it('uses absolute --config path directly without joining workdir', async () => {
    mockTaggingSend.mockResolvedValueOnce({ ResourceTagMappingList: [], PaginationToken: null });

    await remove('/workspace', '/absolute/path/serverless.js');

    expect(loadConfig).toHaveBeenCalledWith('/absolute/path/serverless.js');
  });

  it('defaults to cfnless.yml in workdir when no --config is provided', async () => {
    mockTaggingSend.mockResolvedValueOnce({ ResourceTagMappingList: [], PaginationToken: null });

    await remove('/workspace', null);

    expect(loadConfig).toHaveBeenCalledWith('/workspace/cfnless.yml');
  });

  it('deletes log groups for all discovered tagged functions', async () => {
    const arns = [
      'arn:aws:lambda:us-east-1:123:function:cf-abc123-dev-api',
      'arn:aws:lambda:us-east-1:123:function:cf-abc123-dev-abc123',
    ];
    mockTaggingSend.mockResolvedValueOnce({
      ResourceTagMappingList: arns.map((ResourceARN) => ({ ResourceARN })),
      PaginationToken: null,
    });

    await remove('/workspace', null);

    expect(mockCW.deleteLogGroup).toHaveBeenCalledWith('/aws/lambda/cf-abc123-dev-api');
    expect(mockCW.deleteLogGroup).toHaveBeenCalledWith('/aws/lambda/cf-abc123-dev-abc123');
  });

  it('throws with a failure summary when one function deletion fails but still attempts the rest', async () => {
    // Bug fix: Promise.allSettled means all functions are attempted even if one fails.
    const arns = [
      'arn:aws:lambda:us-east-1:123:function:cf-abc123-dev-api',
      'arn:aws:lambda:us-east-1:123:function:cf-abc123-dev-abc123',
    ];
    mockTaggingSend.mockResolvedValueOnce({
      ResourceTagMappingList: arns.map((ResourceARN) => ({ ResourceARN })),
      PaginationToken: null,
    });

    // First deleteFunction fails, second succeeds
    mockLambda.deleteFunction
      .mockRejectedValueOnce(new Error('ThrottlingException: Rate exceeded'))
      .mockResolvedValueOnce(undefined);
    mockCW.deleteLogGroup.mockResolvedValue(undefined);

    await expect(remove('/workspace', null)).rejects.toThrow('Failed to remove 1 of 2');
    // Second function was still attempted despite first failing
    expect(mockLambda.deleteFunction).toHaveBeenCalledTimes(2);
  });
});
