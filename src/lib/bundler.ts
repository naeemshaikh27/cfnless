import * as esbuild from 'esbuild';
import archiver from 'archiver';
import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';
import type { BundleResult } from '../types';

export const ARTIFACTS_DIR = '.cfnless';

let _globalNodeModulesCache: string | null = null;

function getGlobalNodeModules(): string {
  if (!_globalNodeModulesCache) {
    try {
      _globalNodeModulesCache = execSync('npm root -g', { encoding: 'utf8' }).trim();
    } catch (err) {
      throw new Error(`Failed to determine global node_modules path: ${err.message}`);
    }
  }
  return _globalNodeModulesCache;
}

export async function bundleAndZip(
  handlerName: string,
  workdir: string,
  target: string | undefined,
  functionName: string
): Promise<BundleResult> {
  const globalNodeModules = getGlobalNodeModules();

  const artifactsDir = path.join(workdir, ARTIFACTS_DIR);
  fs.mkdirSync(artifactsDir, { recursive: true });
  const bundledFile = path.join(artifactsDir, `${functionName}.js`);
  const zipFile = path.join(artifactsDir, `${functionName}.zip`);

  const entryPoint = path.join(workdir, `${handlerName}.ts`);
  if (!fs.existsSync(entryPoint)) {
    throw new Error(`Handler entry point not found: ${entryPoint}`);
  }

  try {
    await esbuild.build({
      entryPoints: [entryPoint],
      bundle: true,
      platform: 'node',
      target: target || 'node18',
      outfile: bundledFile,
      nodePaths: [globalNodeModules],
      absWorkingDir: workdir,
      logLevel: 'warning',
      sourcemap: false,
    });
  } catch (err) {
    throw new Error(`esbuild bundling failed for ${handlerName}: ${err.message}`);
  }

  await createZip(bundledFile, zipFile);

  return { zipFile };
}

function createZip(bundledFile: string, zipFile: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipFile);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', resolve);
    archive.on('error', reject);

    archive.pipe(output);
    archive.file(bundledFile, { name: 'index.js' });
    archive.finalize();
  });
}
