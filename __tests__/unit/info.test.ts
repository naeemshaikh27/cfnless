jest.mock('../../src/lib/config-loader');
jest.mock('../../src/lib/lambda-manager');

import { loadConfig, resolveConfigPath } from '../../src/lib/config-loader';
import { LambdaManager } from '../../src/lib/lambda-manager';
import info from '../../src/lib/info';

describe('info', () => {
  let mockLambda: { getFunctionUrl: jest.Mock };
  let stdoutOutput: string;
  let stdoutSpy: jest.SpyInstance;

  const BASE_CONFIG = {
    service: 'cf-abc123',
    stage: 'dev',
    provider: { region: 'us-east-1', runtime: 'nodejs20.x', deploymentBucket: null, deploymentPrefix: 'serverless', logRetentionInDays: 14 },
    functions: {},
  };

  beforeEach(() => {
    jest.resetAllMocks();
    stdoutOutput = '';
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation((str) => {
      stdoutOutput += str;
      return true;
    });
    mockLambda = { getFunctionUrl: jest.fn() };
    jest.mocked(LambdaManager).mockImplementation(() => mockLambda as unknown as LambdaManager);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
  });

  it('outputs YAML starting with "service:" for Go parser compatibility (single function uses "endpoint:")', async () => {
    jest.mocked(loadConfig).mockReturnValue({ ...BASE_CONFIG, functions: { api: {} } });
    mockLambda.getFunctionUrl.mockResolvedValue('https://abc.lambda-url.us-east-1.on.aws/');

    await info('/workspace');

    expect(stdoutOutput).toMatch(/^service:/);
    expect(stdoutOutput).toContain('endpoint:');
    expect(stdoutOutput).toContain('https://abc.lambda-url.us-east-1.on.aws/');
    expect(stdoutOutput).not.toContain('endpoints:');
  });

  it('outputs "endpoints:" map for multiple functions (not "endpoint:")', async () => {
    jest.mocked(loadConfig).mockReturnValue({
      ...BASE_CONFIG,
      functions: { api: {}, abc123: {} },
    });
    mockLambda.getFunctionUrl
      .mockResolvedValueOnce('https://url1.lambda-url.us-east-1.on.aws/')
      .mockResolvedValueOnce('https://url2.lambda-url.us-east-1.on.aws/');

    await info('/workspace');

    expect(stdoutOutput).toMatch(/^service:/);
    expect(stdoutOutput).toContain('endpoints:');
    expect(stdoutOutput).toContain('api:');
    expect(stdoutOutput).toContain('abc123:');
    expect(stdoutOutput).not.toMatch(/^endpoint:/m);
  });

  it('uses exact function keys from cfnless.yml in endpoints map (Go parser parses by key)', async () => {
    const functionKey = '3ed10a7d12d348c9187f3b6c9dc5c604';
    jest.mocked(loadConfig).mockReturnValue({
      ...BASE_CONFIG,
      functions: { api: {}, [functionKey]: {} },
    });
    mockLambda.getFunctionUrl
      .mockResolvedValueOnce('https://url1.lambda-url.us-east-1.on.aws/')
      .mockResolvedValueOnce('https://url2.lambda-url.us-east-1.on.aws/');

    await info('/workspace');

    expect(stdoutOutput).toContain(`${functionKey}:`);
  });

  it('outputs empty string for function endpoint when URL config returns null', async () => {
    jest.mocked(loadConfig).mockReturnValue({ ...BASE_CONFIG, functions: { api: {} } });
    mockLambda.getFunctionUrl.mockResolvedValue(null);

    await info('/workspace');

    expect(stdoutOutput).toMatch(/^service:/);
    expect(stdoutOutput).toContain('endpoint:');
  });

  it('constructs Lambda function name using "{service}-{stage}-{functionKey}" convention', async () => {
    jest.mocked(loadConfig).mockReturnValue({ ...BASE_CONFIG, functions: { api: {} } });
    mockLambda.getFunctionUrl.mockResolvedValue('https://abc.lambda-url.us-east-1.on.aws/');

    await info('/workspace');

    expect(mockLambda.getFunctionUrl).toHaveBeenCalledWith('cf-abc123-dev-api');
  });

  it('outputs service, stage, region, and stack fields in the YAML', async () => {
    jest.mocked(loadConfig).mockReturnValue({ ...BASE_CONFIG, functions: { api: {} } });
    mockLambda.getFunctionUrl.mockResolvedValue('https://abc.lambda-url.us-east-1.on.aws/');

    await info('/workspace');

    expect(stdoutOutput).toContain('stage:');
    expect(stdoutOutput).toContain('region:');
    expect(stdoutOutput).toContain('stack:');
    expect(stdoutOutput).toContain('cf-abc123-dev');
  });

  it('outputs only service info when no functions are defined', async () => {
    jest.mocked(loadConfig).mockReturnValue({ ...BASE_CONFIG, functions: {} });

    await info('/workspace');

    expect(stdoutOutput).toMatch(/^service:/);
    expect(mockLambda.getFunctionUrl).not.toHaveBeenCalled();
  });

  it('does not crash when getFunctionUrl throws — writes stderr warning and outputs null endpoint', async () => {
    // Bug fix: non-404 errors (network, permissions) must not crash the info command.
    // The Go deployment agent reads stdout and checks exit code — a crash leaves it with
    // no endpoint data and a non-zero exit, which fails the deployment.
    jest.mocked(loadConfig).mockReturnValue({ ...BASE_CONFIG, functions: { api: {} } });
    mockLambda.getFunctionUrl.mockRejectedValue(new Error('Network timeout'));

    await expect(info('/workspace')).resolves.toBeUndefined();

    expect(stdoutOutput).toMatch(/^service:/);
    expect(stdoutOutput).toContain('endpoint:');
  });

  it('writes a warning to stderr for the function that threw, not stdout', async () => {
    jest.mocked(loadConfig).mockReturnValue({ ...BASE_CONFIG, functions: { api: {} } });
    mockLambda.getFunctionUrl.mockRejectedValue(new Error('AccessDenied'));

    const stderrMessages: string[] = [];
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation((s) => {
      stderrMessages.push(s as string);
      return true;
    });

    await info('/workspace');

    expect(stderrMessages.some((m) => m.includes('cf-abc123-dev-api'))).toBe(true);
    expect(stderrMessages.some((m) => m.includes('AccessDenied'))).toBe(true);
    stderrSpy.mockRestore();
  });

  it('returns partial results when one of multiple functions throws and another succeeds', async () => {
    jest.mocked(loadConfig).mockReturnValue({
      ...BASE_CONFIG,
      functions: { api: {}, abc123: {} },
    });
    mockLambda.getFunctionUrl
      .mockResolvedValueOnce('https://url1.lambda-url.us-east-1.on.aws/')
      .mockRejectedValueOnce(new Error('Network timeout'));

    await expect(info('/workspace')).resolves.toBeUndefined();

    expect(stdoutOutput).toContain('api:');
    expect(stdoutOutput).toContain('https://url1.lambda-url.us-east-1.on.aws/');
    expect(stdoutOutput).toContain('abc123:');
  });

  it('passes configPath to resolveConfigPath', async () => {
    jest.mocked(loadConfig).mockReturnValue({ ...BASE_CONFIG, functions: {} });
    jest.mocked(resolveConfigPath).mockReturnValue('/workspace/custom.yml');
    await info('/workspace', 'custom.yml');
    expect(resolveConfigPath).toHaveBeenCalledWith('/workspace', 'custom.yml');
    expect(loadConfig).toHaveBeenCalledWith('/workspace/custom.yml');
  });
});
