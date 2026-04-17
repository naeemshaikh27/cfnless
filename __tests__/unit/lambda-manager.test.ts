import {
  LambdaClient,
  GetFunctionCommand,
  CreateFunctionCommand,
  UpdateFunctionCodeCommand,
  UpdateFunctionConfigurationCommand,
  GetFunctionUrlConfigCommand,
  CreateFunctionUrlConfigCommand,
  UpdateFunctionUrlConfigCommand,
  AddPermissionCommand,
  TagResourceCommand,
  DeleteFunctionCommand,
  waitUntilFunctionUpdated,
  waitUntilFunctionActiveV2,
} from '@aws-sdk/client-lambda';
import { LambdaManager } from '../../src/lib/lambda-manager';

jest.mock('@aws-sdk/client-lambda');

// AWS SDK v3: when the module is mocked, Command constructors don't store .input.
// Instead, inspect CommandClass.mock.calls[N][0] to see the input passed to the constructor.
// Use mockSend call index to verify which command was sent in what order.

describe('LambdaManager', () => {
  let mockSend: jest.Mock;
  let manager: LambdaManager;

  const FUNCTION_NAME = 'cf-abc123-dev-api';
  const IMAGE_URI = '123.dkr.ecr.us-east-1.amazonaws.com/repo:env-dep';
  const ROLE = 'arn:aws:iam::123:role/my-role';
  const FUNCTION_ARN = `arn:aws:lambda:us-east-1:123:function:${FUNCTION_NAME}`;

  const BASE_CONFIG = {
    image: IMAGE_URI,
    role: ROLE,
    timeout: 30,
    memorySize: 2048,
    urlConfig: {},
    tags: { ServerlessService: 'cf-abc123', DeploymentUid: 'abc123' },
  };

  function makeNotFound() {
    return Object.assign(new Error('not found'), { name: 'ResourceNotFoundException' });
  }

  beforeEach(() => {
    jest.resetAllMocks();
    mockSend = jest.fn();
    jest.mocked(LambdaClient).mockImplementation(() => ({ send: mockSend }) as unknown as LambdaClient);
    jest.mocked(waitUntilFunctionActiveV2).mockResolvedValue({} as never);
    jest.mocked(waitUntilFunctionUpdated).mockResolvedValue({} as never);
    manager = new LambdaManager('us-east-1');
  });

  describe('createOrUpdateContainerFunction', () => {
    it('creates a new container function, tags it, and creates a public function URL when function does not exist', async () => {
      mockSend
        .mockRejectedValueOnce(makeNotFound())
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ Configuration: { FunctionArn: FUNCTION_ARN } })
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(makeNotFound())
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({});

      await manager.createOrUpdateContainerFunction(FUNCTION_NAME, BASE_CONFIG);

      expect(mockSend.mock.calls[1][0]).toBeInstanceOf(CreateFunctionCommand);
      const createInput = jest.mocked(CreateFunctionCommand).mock.calls[0][0];
      expect(createInput.PackageType).toBe('Image');
      expect(createInput.Code!.ImageUri).toBe(IMAGE_URI);
      expect(createInput.Role).toBe(ROLE);
      expect(createInput.Timeout).toBe(30);
      expect(createInput.MemorySize).toBe(2048);

      expect(mockSend.mock.calls[3][0]).toBeInstanceOf(TagResourceCommand);
      expect(mockSend.mock.calls[4][0]).toBeInstanceOf(GetFunctionUrlConfigCommand);
      expect(mockSend.mock.calls[5][0]).toBeInstanceOf(CreateFunctionUrlConfigCommand);
      expect(mockSend.mock.calls[6][0]).toBeInstanceOf(AddPermissionCommand);
    });

    it('updates code and config when function already exists, and skips URL update when unchanged', async () => {
      mockSend
        .mockResolvedValueOnce({ Configuration: { FunctionArn: FUNCTION_ARN } })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ Configuration: { FunctionArn: FUNCTION_ARN } })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ AuthType: 'NONE', InvokeMode: 'BUFFERED' })
        .mockResolvedValueOnce({});

      await manager.createOrUpdateContainerFunction(FUNCTION_NAME, BASE_CONFIG);

      expect(mockSend.mock.calls[1][0]).toBeInstanceOf(UpdateFunctionCodeCommand);
      expect(mockSend.mock.calls[2][0]).toBeInstanceOf(UpdateFunctionConfigurationCommand);
      const commandTypes = mockSend.mock.calls.map((c) => c[0].constructor.name);
      expect(commandTypes).not.toContain('UpdateFunctionUrlConfigCommand');
    });

    it('creates function URL with AWS_IAM auth type and does NOT add public permission', async () => {
      mockSend
        .mockRejectedValueOnce(makeNotFound())
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ Configuration: { FunctionArn: FUNCTION_ARN } })
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(makeNotFound())
        .mockResolvedValueOnce({});

      await manager.createOrUpdateContainerFunction(FUNCTION_NAME, {
        ...BASE_CONFIG,
        urlConfig: { authorizer: 'aws_iam', invokeMode: null },
      });

      expect(mockSend.mock.calls[5][0]).toBeInstanceOf(CreateFunctionUrlConfigCommand);
      const createUrlInput = jest.mocked(CreateFunctionUrlConfigCommand).mock.calls[0][0];
      expect(createUrlInput.AuthType).toBe('AWS_IAM');

      const commandTypes = mockSend.mock.calls.map((c) => c[0].constructor.name);
      expect(commandTypes).not.toContain('AddPermissionCommand');
    });

    it('sets RESPONSE_STREAM invoke mode when configured', async () => {
      mockSend
        .mockRejectedValueOnce(makeNotFound())
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ Configuration: { FunctionArn: FUNCTION_ARN } })
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(makeNotFound())
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({});

      await manager.createOrUpdateContainerFunction(FUNCTION_NAME, {
        ...BASE_CONFIG,
        urlConfig: { authorizer: null, invokeMode: 'RESPONSE_STREAM' },
      });

      const createUrlInput = jest.mocked(CreateFunctionUrlConfigCommand).mock.calls[0][0];
      expect(createUrlInput.InvokeMode).toBe('RESPONSE_STREAM');
    });

    it('handles ResourceConflictException when adding public policy (permission already exists)', async () => {
      const conflict = Object.assign(new Error('conflict'), { name: 'ResourceConflictException' });

      mockSend
        .mockResolvedValueOnce({ Configuration: { FunctionArn: FUNCTION_ARN } })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ Configuration: { FunctionArn: FUNCTION_ARN } })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ AuthType: 'NONE', InvokeMode: 'BUFFERED' })
        .mockRejectedValueOnce(conflict);

      await expect(
        manager.createOrUpdateContainerFunction(FUNCTION_NAME, BASE_CONFIG)
      ).resolves.toBeUndefined();
    });

    it('updates function URL config when auth type changes', async () => {
      mockSend
        .mockResolvedValueOnce({ Configuration: { FunctionArn: FUNCTION_ARN } })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ Configuration: { FunctionArn: FUNCTION_ARN } })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ AuthType: 'AWS_IAM', InvokeMode: 'BUFFERED' })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({});

      await manager.createOrUpdateContainerFunction(FUNCTION_NAME, {
        ...BASE_CONFIG,
        urlConfig: {},
      });

      expect(mockSend.mock.calls[6][0]).toBeInstanceOf(UpdateFunctionUrlConfigCommand);
    });
  });

  describe('createOrUpdateZipFunction', () => {
    const ZIP_CONFIG = {
      s3Bucket: 'my-bucket',
      s3Key: 'service/zips/fn.zip',
      handler: 'index.handler',
      role: ROLE,
      timeout: 30,
      memorySize: 1024,
      runtime: 'nodejs20.x',
      environment: { MY_VAR: 'hello' },
      urlConfig: {},
      tags: { ServerlessService: 'cf-abc123' },
    };

    it('creates a new zip function with environment variables, tags, and public URL', async () => {
      mockSend
        .mockRejectedValueOnce(makeNotFound())
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ Configuration: { FunctionArn: FUNCTION_ARN } })
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(makeNotFound())
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({});

      await manager.createOrUpdateZipFunction(FUNCTION_NAME, ZIP_CONFIG);

      expect(mockSend.mock.calls[1][0]).toBeInstanceOf(CreateFunctionCommand);
      const createInput = jest.mocked(CreateFunctionCommand).mock.calls[0][0];
      expect(createInput.PackageType).toBe('Zip');
      expect((createInput.Environment!.Variables as Record<string, string>).MY_VAR).toBe('hello');
      expect(createInput.Handler).toBe('index.handler');
    });

    it('updates an existing zip function with new S3 key and configuration', async () => {
      mockSend
        .mockResolvedValueOnce({ Configuration: { FunctionArn: FUNCTION_ARN } })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ Configuration: { FunctionArn: FUNCTION_ARN } })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ AuthType: 'NONE', InvokeMode: 'BUFFERED' })
        .mockResolvedValueOnce({});

      await manager.createOrUpdateZipFunction(FUNCTION_NAME, ZIP_CONFIG);

      expect(mockSend.mock.calls[1][0]).toBeInstanceOf(UpdateFunctionCodeCommand);
      const updateCodeInput = jest.mocked(UpdateFunctionCodeCommand).mock.calls[0][0];
      expect(updateCodeInput.S3Bucket).toBe('my-bucket');
      expect(updateCodeInput.S3Key).toBe('service/zips/fn.zip');

      expect(mockSend.mock.calls[2][0]).toBeInstanceOf(UpdateFunctionConfigurationCommand);
    });
  });

  describe('deleteFunction', () => {
    it('sends DeleteFunctionCommand for the given function name', async () => {
      mockSend.mockResolvedValueOnce({});

      await manager.deleteFunction(FUNCTION_NAME);

      expect(mockSend).toHaveBeenCalledWith(expect.any(DeleteFunctionCommand));
      expect(jest.mocked(DeleteFunctionCommand).mock.calls[0][0]).toMatchObject({ FunctionName: FUNCTION_NAME });
    });

    it('writes "does not exist" to stdout and resolves cleanly when function is missing', async () => {
      mockSend.mockRejectedValueOnce(makeNotFound());
      const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);

      await expect(manager.deleteFunction(FUNCTION_NAME)).resolves.toBeUndefined();
      expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('does not exist'));

      stdoutSpy.mockRestore();
    });
  });

  describe('getFunctionUrl', () => {
    it('returns the FunctionUrl string when URL config exists', async () => {
      mockSend.mockResolvedValueOnce({ FunctionUrl: 'https://abc.lambda-url.us-east-1.on.aws/' });

      const url = await manager.getFunctionUrl(FUNCTION_NAME);

      expect(url).toBe('https://abc.lambda-url.us-east-1.on.aws/');
    });

    it('returns null when function URL config does not exist', async () => {
      mockSend.mockRejectedValueOnce(makeNotFound());

      const url = await manager.getFunctionUrl(FUNCTION_NAME);

      expect(url).toBeNull();
    });
  });

  describe('_upsertFunctionUrl with urlConfig null', () => {
    it('does NOT create a function URL when urlConfig is null — no URL commands sent', async () => {
      mockSend
        .mockRejectedValueOnce(makeNotFound())
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ Configuration: { FunctionArn: FUNCTION_ARN } })
        .mockResolvedValueOnce({});

      await manager.createOrUpdateContainerFunction(FUNCTION_NAME, {
        ...BASE_CONFIG,
        urlConfig: null,
      });

      const commandTypes = mockSend.mock.calls.map((c) => c[0].constructor.name);
      expect(commandTypes).not.toContain('GetFunctionUrlConfigCommand');
      expect(commandTypes).not.toContain('CreateFunctionUrlConfigCommand');
      expect(commandTypes).not.toContain('AddPermissionCommand');
    });

    it('does NOT create a function URL when urlConfig is undefined', async () => {
      mockSend
        .mockRejectedValueOnce(makeNotFound())
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ Configuration: { FunctionArn: FUNCTION_ARN } })
        .mockResolvedValueOnce({});

      await manager.createOrUpdateContainerFunction(FUNCTION_NAME, {
        ...BASE_CONFIG,
        urlConfig: undefined,
      });

      const commandTypes = mockSend.mock.calls.map((c) => c[0].constructor.name);
      expect(commandTypes).not.toContain('CreateFunctionUrlConfigCommand');
    });
  });

  describe('_waitForActive error wrapping', () => {
    it('wraps waiter rejection with function name in error message', async () => {
      mockSend.mockRejectedValueOnce(makeNotFound());
      mockSend.mockResolvedValueOnce({});
      jest.mocked(waitUntilFunctionActiveV2).mockRejectedValue(new Error('Waiter timed out'));

      await expect(
        manager.createOrUpdateContainerFunction(FUNCTION_NAME, BASE_CONFIG)
      ).rejects.toThrow(FUNCTION_NAME);
    });
  });

  describe('getFunction', () => {
    it('returns function details when function exists', async () => {
      const mockResult = { Configuration: { FunctionName: FUNCTION_NAME } };
      mockSend.mockResolvedValueOnce(mockResult);

      const result = await manager.getFunction(FUNCTION_NAME);

      expect(result).toEqual(mockResult);
      expect(mockSend.mock.calls[0][0]).toBeInstanceOf(GetFunctionCommand);
    });

    it('returns null when function does not exist', async () => {
      mockSend.mockRejectedValueOnce(makeNotFound());

      const result = await manager.getFunction(FUNCTION_NAME);

      expect(result).toBeNull();
    });
  });
});
