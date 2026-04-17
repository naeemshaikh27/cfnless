jest.mock('esbuild');
jest.mock('archiver');
jest.mock('child_process');
jest.mock('fs');

describe('bundler', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let esbuild: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let archiver: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fs: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let childProcess: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockArchive: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockOutput: any;

  beforeEach(() => {
    jest.resetModules();

    esbuild = require('esbuild');
    archiver = require('archiver');
    fs = require('fs');
    childProcess = require('child_process');

    childProcess.execSync = jest.fn().mockReturnValue('/usr/local/lib/node_modules\n');
    fs.mkdirSync = jest.fn();
    fs.existsSync = jest.fn().mockReturnValue(true);

    mockOutput = { on: jest.fn() };
    mockOutput.on.mockImplementation(function (event: string, cb: () => void) {
      if (event === 'close') cb();
      return mockOutput;
    });
    fs.createWriteStream = jest.fn().mockReturnValue(mockOutput);

    mockArchive = {
      pipe: jest.fn(),
      file: jest.fn(),
      finalize: jest.fn(),
      on: jest.fn().mockReturnThis(),
    };
    archiver.mockReturnValue(mockArchive);

    esbuild.build = jest.fn().mockResolvedValue({});
  });

  it('writes bundle and zip to .cfnless/ and returns the zip path', async () => {
    const { bundleAndZip } = require('../../src/lib/bundler');

    const result = await bundleAndZip('myfunc', '/workspace', 'node20', 'svc-dev-myfunc');

    expect(fs.mkdirSync).toHaveBeenCalledWith('/workspace/.cfnless', { recursive: true });
    expect(esbuild.build).toHaveBeenCalledWith(
      expect.objectContaining({
        bundle: true,
        platform: 'node',
        target: 'node20',
        absWorkingDir: '/workspace',
        outfile: '/workspace/.cfnless/svc-dev-myfunc.js',
        sourcemap: false,
      })
    );
    expect(result.zipFile).toBe('/workspace/.cfnless/svc-dev-myfunc.zip');
    expect(mockArchive.pipe).toHaveBeenCalledWith(mockOutput);
    expect(mockArchive.file).toHaveBeenCalledWith(
      '/workspace/.cfnless/svc-dev-myfunc.js',
      { name: 'index.js' }
    );
    expect(mockArchive.finalize).toHaveBeenCalled();
  });

  it('uses node20 as default target when target argument is omitted', async () => {
    const { bundleAndZip } = require('../../src/lib/bundler');

    await bundleAndZip('myfunc', '/workspace', undefined, 'svc-dev-myfunc');

    expect(esbuild.build).toHaveBeenCalledWith(
      expect.objectContaining({ target: 'node20' })
    );
  });

  it('falls back to .js entry point when .ts does not exist', async () => {
    fs.existsSync = jest.fn()
      .mockReturnValueOnce(false)  // .ts does not exist
      .mockReturnValueOnce(true);  // .js exists
    const { bundleAndZip } = require('../../src/lib/bundler');

    await bundleAndZip('myfunc', '/workspace', 'node20', 'svc-dev-myfunc');

    expect(esbuild.build).toHaveBeenCalledWith(
      expect.objectContaining({ entryPoints: ['/workspace/myfunc.js'] })
    );
  });

  it('throws when neither .ts nor .js entry point exists', async () => {
    fs.existsSync = jest.fn().mockReturnValue(false);
    const { bundleAndZip } = require('../../src/lib/bundler');

    await expect(
      bundleAndZip('missing-func', '/workspace', 'node18', 'svc-dev-missing')
    ).rejects.toThrow('Handler entry point not found');
    expect(esbuild.build).not.toHaveBeenCalled();
  });

  it('wraps esbuild errors with function name context', async () => {
    esbuild.build = jest.fn().mockRejectedValue(new Error('syntax error'));
    const { bundleAndZip } = require('../../src/lib/bundler');

    await expect(
      bundleAndZip('myfunc', '/workspace', 'node20', 'svc-dev-myfunc')
    ).rejects.toThrow('esbuild bundling failed for myfunc');
  });

  it('passes exclude (serverless-esbuild name) to esbuild as external', async () => {
    const { bundleAndZip } = require('../../src/lib/bundler');

    await bundleAndZip('myfunc', '/workspace', 'node20', 'svc-dev-myfunc', {
      exclude: ['sharp', 'canvas'],
    });

    expect(esbuild.build).toHaveBeenCalledWith(
      expect.objectContaining({ external: ['sharp', 'canvas'] })
    );
  });

  it('passes external (esbuild-native alias) to esbuild as external', async () => {
    const { bundleAndZip } = require('../../src/lib/bundler');

    await bundleAndZip('myfunc', '/workspace', 'node20', 'svc-dev-myfunc', {
      external: ['aws-sdk'],
    });

    expect(esbuild.build).toHaveBeenCalledWith(
      expect.objectContaining({ external: ['aws-sdk'] })
    );
  });

  it('merges exclude and external into a single esbuild external list', async () => {
    const { bundleAndZip } = require('../../src/lib/bundler');

    await bundleAndZip('myfunc', '/workspace', 'node20', 'svc-dev-myfunc', {
      exclude: ['sharp'],
      external: ['aws-sdk'],
    });

    expect(esbuild.build).toHaveBeenCalledWith(
      expect.objectContaining({ external: ['sharp', 'aws-sdk'] })
    );
  });

  it('passes minify, sourcemap, and tsconfig options to esbuild.build', async () => {
    const { bundleAndZip } = require('../../src/lib/bundler');

    await bundleAndZip('myfunc', '/workspace', 'node20', 'svc-dev-myfunc', {
      minify: true,
      sourcemap: 'inline',
      tsconfig: 'tsconfig.build.json',
    });

    expect(esbuild.build).toHaveBeenCalledWith(
      expect.objectContaining({
        minify: true,
        sourcemap: 'inline',
        tsconfig: 'tsconfig.build.json',
      })
    );
  });

  it('omits minify, external, and tsconfig from esbuild call when not provided', async () => {
    const { bundleAndZip } = require('../../src/lib/bundler');

    await bundleAndZip('myfunc', '/workspace', 'node20', 'svc-dev-myfunc');

    const call = (esbuild.build as jest.Mock).mock.calls[0][0];
    expect(call).not.toHaveProperty('minify');
    expect(call).not.toHaveProperty('external');
    expect(call).not.toHaveProperty('tsconfig');
    expect(call.sourcemap).toBe(false);
  });
});
