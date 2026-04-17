import fs from 'fs';
import os from 'os';
import path from 'path';
import { bundleAndZip } from '../../src/lib/bundler';

// Does NOT require Docker — exercises real esbuild and archiver against the local filesystem.
//
// The unit tests in bundler.test.ts mock esbuild, archiver, and fs entirely, so they never
// verify that the two tools produce a usable artifact. This test fills that gap.

describe('bundler integration (real esbuild + archiver)', () => {
  let workdir: string;

  beforeEach(() => {
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfnless-bundler-inttest-'));
  });

  afterEach(() => {
    fs.rmSync(workdir, { recursive: true, force: true });
  });

  it('bundles a TypeScript handler and produces a valid zip file', async () => {
    fs.writeFileSync(
      path.join(workdir, 'handler.ts'),
      'export const handler = async () => ({ statusCode: 200 });'
    );

    const result = await bundleAndZip('handler', workdir, 'node20', 'svc-dev-api');

    expect(result.zipFile).toBe(path.join(workdir, '.cfnless', 'svc-dev-api.zip'));
    expect(fs.existsSync(result.zipFile)).toBe(true);

    // Zip files begin with the local file header signature PK\x03\x04
    const zipBytes = fs.readFileSync(result.zipFile);
    expect(zipBytes.slice(0, 2).toString()).toBe('PK');

    // The bundled JS (which becomes index.js inside the zip) should also exist
    const bundledJs = path.join(workdir, '.cfnless', 'svc-dev-api.js');
    expect(fs.existsSync(bundledJs)).toBe(true);
    expect(fs.readFileSync(bundledJs, 'utf8')).toContain('statusCode');
  });

  it('inlines imported local modules into the bundle', async () => {
    fs.writeFileSync(path.join(workdir, 'utils.ts'), 'export const greet = () => "hello";');
    fs.writeFileSync(
      path.join(workdir, 'main.ts'),
      'import { greet } from "./utils"; export const handler = async () => greet();'
    );

    const result = await bundleAndZip('main', workdir, 'node20', 'svc-dev-main');

    expect(fs.existsSync(result.zipFile)).toBe(true);

    // esbuild should tree-shake and inline utils — the bundle contains the string literal
    const bundledJs = fs.readFileSync(path.join(workdir, '.cfnless', 'svc-dev-main.js'), 'utf8');
    expect(bundledJs).toContain('hello');
  });

  it('bundles a plain JavaScript (.js) handler when no .ts file is present', async () => {
    fs.writeFileSync(
      path.join(workdir, 'handler.js'),
      'exports.handler = async () => ({ statusCode: 200, body: "ok" });'
    );

    const result = await bundleAndZip('handler', workdir, 'node20', 'svc-dev-jshandler');

    expect(fs.existsSync(result.zipFile)).toBe(true);
    const bundledJs = fs.readFileSync(
      path.join(workdir, '.cfnless', 'svc-dev-jshandler.js'),
      'utf8'
    );
    expect(bundledJs).toContain('statusCode');
  });

  it('excludes a package from the bundle when passed via exclude option', async () => {
    // Write a handler that imports a package that will be excluded.
    // We use 'path' (a Node built-in) as a stand-in so the test doesn't need
    // a real npm install — the key is that exclude correctly marks it external
    // and esbuild does not inline it.
    fs.writeFileSync(
      path.join(workdir, 'handler.ts'),
      `import path from 'path';
       export const handler = async () => path.join('a', 'b');`
    );

    await bundleAndZip('handler', workdir, 'node20', 'svc-dev-exclude', {
      exclude: ['path'],
    });

    const bundledJs = fs.readFileSync(
      path.join(workdir, '.cfnless', 'svc-dev-exclude.js'),
      'utf8'
    );
    // When 'path' is external, esbuild emits a require('path') call rather than inlining it
    expect(bundledJs).toContain('require("path")');
  });

  it('emits an inline sourcemap comment when sourcemap is set to inline', async () => {
    fs.writeFileSync(
      path.join(workdir, 'handler.ts'),
      'export const handler = async () => ({ statusCode: 200 });'
    );

    await bundleAndZip('handler', workdir, 'node20', 'svc-dev-sourcemap', {
      sourcemap: 'inline',
    });

    const bundledJs = fs.readFileSync(
      path.join(workdir, '.cfnless', 'svc-dev-sourcemap.js'),
      'utf8'
    );
    expect(bundledJs).toContain('//# sourceMappingURL=data:application/json');
  });

  it('throws when the handler .ts file does not exist', async () => {
    await expect(
      bundleAndZip('nonexistent', workdir, 'node20', 'svc-dev-missing')
    ).rejects.toThrow('Handler entry point not found');
  });

  it('throws with esbuild context when the handler has a syntax error', async () => {
    fs.writeFileSync(path.join(workdir, 'broken.ts'), 'export const handler = (((;');

    await expect(
      bundleAndZip('broken', workdir, 'node20', 'svc-dev-broken')
    ).rejects.toThrow('esbuild bundling failed for broken');
  });
});
