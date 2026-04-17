import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadConfig, resolveConfigPath } from '../../src/lib/config-loader';

// Does NOT require Docker — tests real file I/O including the require() path for .js configs.
//
// The unit tests mock fs entirely, so they never exercise the actual file-read or require() branch.
// This test fills that gap for .js configs and the auto-detection fallback chain.

describe('config-loader integration (real filesystem)', () => {
  let workdir: string;

  beforeEach(() => {
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfnless-config-inttest-'));
  });

  afterEach(() => {
    fs.rmSync(workdir, { recursive: true, force: true });
  });

  describe('resolveConfigPath auto-detection', () => {
    it('picks cfnless.yml first when multiple configs exist', () => {
      fs.writeFileSync(path.join(workdir, 'cfnless.yml'), '');
      fs.writeFileSync(path.join(workdir, 'serverless.yml'), '');
      expect(resolveConfigPath(workdir, null)).toBe(path.join(workdir, 'cfnless.yml'));
    });

    it('falls back to serverless.yml when cfnless.yml is absent', () => {
      fs.writeFileSync(path.join(workdir, 'serverless.yml'), '');
      expect(resolveConfigPath(workdir, null)).toBe(path.join(workdir, 'serverless.yml'));
    });

    it('falls back to cfnless.js when both yml files are absent', () => {
      fs.writeFileSync(path.join(workdir, 'cfnless.js'), '');
      expect(resolveConfigPath(workdir, null)).toBe(path.join(workdir, 'cfnless.js'));
    });

    it('falls back to serverless.js when yml files and cfnless.js are absent', () => {
      fs.writeFileSync(path.join(workdir, 'serverless.js'), '');
      expect(resolveConfigPath(workdir, null)).toBe(path.join(workdir, 'serverless.js'));
    });
  });

  describe('loadConfig with a .js config file', () => {
    it('loads and normalizes config exported from a .js file', () => {
      const jsConfig = path.join(workdir, 'cfnless.js');
      fs.writeFileSync(
        jsConfig,
        `module.exports = {
          service: 'js-service',
          provider: { name: 'aws', region: 'eu-west-1' },
          functions: {
            api: { image: '123.dkr.ecr.eu-west-1.amazonaws.com/repo:latest', role: 'arn:aws:iam::123:role/r' }
          }
        };`
      );

      const config = loadConfig(jsConfig);

      expect(config.service).toBe('js-service');
      expect(config.provider.region).toBe('eu-west-1');
      expect(config.provider.runtime).toBe('nodejs20.x');
      expect(config.functions.api.image).toContain('repo:latest');
    });

  });
});
