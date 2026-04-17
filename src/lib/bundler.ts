import * as esbuild from 'esbuild';
import archiver from 'archiver';
import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';
import type { BundleResult, EsbuildConfig } from '../types';

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
  functionName: string,
  esbuildOptions: EsbuildConfig = {}
): Promise<BundleResult> {
  const globalNodeModules = getGlobalNodeModules();

  const artifactsDir = path.join(workdir, ARTIFACTS_DIR);
  fs.mkdirSync(artifactsDir, { recursive: true });
  const bundledFile = path.join(artifactsDir, `${functionName}.js`);
  const zipFile = path.join(artifactsDir, `${functionName}.zip`);

  const tsEntry = path.join(workdir, `${handlerName}.ts`);
  const jsEntry = path.join(workdir, `${handlerName}.js`);
  let entryPoint: string;
  if (fs.existsSync(tsEntry)) {
    entryPoint = tsEntry;
  } else if (fs.existsSync(jsEntry)) {
    entryPoint = jsEntry;
  } else {
    throw new Error(`Handler entry point not found: ${tsEntry} (also tried ${jsEntry})`);
  }

  const { tsconfig, minify, sourcemap, exclude, external } = esbuildOptions;
  const mergedExternal = [...(exclude ?? []), ...(external ?? [])];

  try {
    await esbuild.build({
      entryPoints: [entryPoint],
      bundle: true,
      platform: 'node',
      target: target || 'node20',
      outfile: bundledFile,
      nodePaths: [globalNodeModules],
      absWorkingDir: workdir,
      logLevel: 'warning',
      sourcemap: sourcemap ?? false,
      ...(minify !== undefined && { minify }),
      ...(tsconfig !== undefined && { tsconfig }),
      ...(mergedExternal.length > 0 && { external: mergedExternal }),
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
