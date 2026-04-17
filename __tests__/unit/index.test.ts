// Tests for the CLI entry point (src/index.ts).
// Strategy: mock lib modules and process.exit/stderr, then call main() directly.
// src/index.ts guards auto-execution with require.main === module, so importing it
// here is safe — main() is only called when we invoke it explicitly.

jest.mock('../../src/lib/deploy');
jest.mock('../../src/lib/info');
jest.mock('../../src/lib/remove');

import deploy from '../../src/lib/deploy';
import info from '../../src/lib/info';
import remove from '../../src/lib/remove';
import { main } from '../../src/index';

describe('index.ts CLI', () => {
  let exitSpy: jest.SpyInstance;
  let stderrSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.resetAllMocks();
    jest.mocked(deploy).mockResolvedValue(undefined);
    jest.mocked(info).mockResolvedValue(undefined);
    jest.mocked(remove).mockResolvedValue(undefined);
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
    process.argv = ['node', 'jest'];
  });

  it('calls deploy(cwd, null, null) when command is "deploy"', async () => {
    process.argv = ['node', 'index.js', 'deploy'];
    await main();

    expect(deploy).toHaveBeenCalledWith(process.cwd(), null, null);
  });

  it('calls deploy(cwd, config, function) when flags are provided', async () => {
    process.argv = ['node', 'index.js', 'deploy', '--config', 'custom.yml', '--function', 'api'];
    await main();

    expect(deploy).toHaveBeenCalledWith(process.cwd(), 'custom.yml', 'api');
  });

  it('calls info(cwd, null) when command is "info"', async () => {
    process.argv = ['node', 'index.js', 'info'];
    await main();

    expect(info).toHaveBeenCalledWith(process.cwd(), null);
  });

  it('calls info(cwd, config) when flag is provided', async () => {
    process.argv = ['node', 'index.js', 'info', '--config', 'custom.yml'];
    await main();

    expect(info).toHaveBeenCalledWith(process.cwd(), 'custom.yml');
  });

  it('calls remove(cwd, null, false) when command is "remove" with no --config', async () => {
    process.argv = ['node', 'index.js', 'remove'];
    await main();

    expect(remove).toHaveBeenCalledWith(process.cwd(), null, false, false);
  });

  it('calls remove(cwd, path, false) when --config flag is provided', async () => {
    process.argv = ['node', 'index.js', 'remove', '--config', '/path/to/serverless.js'];
    await main();

    expect(remove).toHaveBeenCalledWith(process.cwd(), '/path/to/serverless.js', false, false);
  });

  it('calls remove with removeCfnStack=true when --remove-cfn-stack flag is provided', async () => {
    process.argv = ['node', 'index.js', 'remove', '--remove-cfn-stack'];
    await main();

    expect(remove).toHaveBeenCalledWith(process.cwd(), null, true, false);
  });

  it('calls remove with removeServerlessS3Artifacts=true when --remove-serverless-s3-artifacts flag is provided', async () => {
    process.argv = ['node', 'index.js', 'remove', '--remove-serverless-s3-artifacts'];
    await main();

    expect(remove).toHaveBeenCalledWith(process.cwd(), null, false, true);
  });

  it('supports both --remove-cfn-stack and --remove-serverless-s3-artifacts together', async () => {
    process.argv = ['node', 'index.js', 'remove', '--remove-cfn-stack', '--remove-serverless-s3-artifacts'];
    await main();

    expect(remove).toHaveBeenCalledWith(process.cwd(), null, true, true);
  });

  it('exits 0 and prints usage when no arguments are given', async () => {
    process.argv = ['node', 'index.js'];
    await main();

    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('exits 0 and prints usage for --help', async () => {
    process.argv = ['node', 'index.js', '--help'];
    await main();

    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('exits 0 and prints usage for -h', async () => {
    process.argv = ['node', 'index.js', '-h'];
    await main();

    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('exits 0 and prints version for --version', async () => {
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    process.argv = ['node', 'index.js', '--version'];
    await main();

    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('cfnless'));
    consoleSpy.mockRestore();
  });

  it('exits 0 and prints version for -v', async () => {
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    process.argv = ['node', 'index.js', '-v'];
    await main();

    expect(exitSpy).toHaveBeenCalledWith(0);
    consoleSpy.mockRestore();
  });

  it('exits 1 and writes error to stderr for an unknown command', async () => {
    process.argv = ['node', 'index.js', 'unknown-command'];
    await main();

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('unknown command'));
  });

  it('exits 1 and writes error to stderr when deploy throws', async () => {
    jest.mocked(deploy).mockRejectedValue(new Error('deploy failed'));
    process.argv = ['node', 'index.js', 'deploy'];
    await main();

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('deploy failed'));
  });

  it('parseConfigFlag returns null when --config is present but no value follows', async () => {
    process.argv = ['node', 'index.js', 'remove', '--config'];
    await main();

    expect(remove).toHaveBeenCalledWith(process.cwd(), null, false, false);
  });
});
