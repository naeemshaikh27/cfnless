import fs from 'fs';
import path from 'path';
import { loadConfig, resolveConfigPath } from '../../src/lib/config-loader';

jest.mock('fs');
jest.mock('js-yaml', () => ({ load: jest.fn() }));
import yaml from 'js-yaml';

const VALID_YAML_PARSED = {
  service: 'cf-abc123',
  provider: {
    name: 'aws',
    region: 'us-east-1',
    runtime: 'nodejs20.x',
    deploymentBucket: { name: 'my-bucket' },
    logRetentionInDays: 14,
  },
  functions: {
    api: {
      image: '123.dkr.ecr.us-east-1.amazonaws.com/repo:tag',
      timeout: 30,
      memorySize: 2048,
      role: 'arn:aws:iam::123:role/my-role',
      url: { authorizer: 'aws_iam', invokeMode: 'RESPONSE_STREAM' },
      tags: { DeploymentUid: 'abc123' },
    },
  },
};

describe('config-loader', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  describe('resolveConfigPath', () => {
    it('returns the given absolute path unchanged', () => {
      expect(resolveConfigPath('/workspace', '/other/dir/my.yml')).toBe('/other/dir/my.yml');
    });

    it('resolves a relative configPath against workdir', () => {
      expect(resolveConfigPath('/workspace', 'subdir/my.yml')).toBe('/workspace/subdir/my.yml');
    });

    it('auto-detects cfnless.yml first when multiple configs exist', () => {
      jest.mocked(fs.existsSync).mockReturnValue(true);
      expect(resolveConfigPath('/workspace', null)).toBe(path.join('/workspace', 'cfnless.yml'));
    });

    it('falls back to serverless.yml when cfnless.yml is absent', () => {
      jest.mocked(fs.existsSync)
        .mockReturnValueOnce(false)  // cfnless.yml absent
        .mockReturnValue(true);      // serverless.yml present
      expect(resolveConfigPath('/workspace', null)).toBe(path.join('/workspace', 'serverless.yml'));
    });

    it('falls back to cfnless.js when both yml files are absent', () => {
      jest.mocked(fs.existsSync)
        .mockReturnValueOnce(false)  // cfnless.yml absent
        .mockReturnValueOnce(false)  // serverless.yml absent
        .mockReturnValue(true);      // cfnless.js present
      expect(resolveConfigPath('/workspace', null)).toBe(path.join('/workspace', 'cfnless.js'));
    });

    it('falls back to serverless.js when yml and cfnless.js are absent', () => {
      jest.mocked(fs.existsSync)
        .mockReturnValueOnce(false)  // cfnless.yml absent
        .mockReturnValueOnce(false)  // serverless.yml absent
        .mockReturnValueOnce(false)  // cfnless.js absent
        .mockReturnValue(true);      // serverless.js present
      expect(resolveConfigPath('/workspace', null)).toBe(path.join('/workspace', 'serverless.js'));
    });

    it('returns cfnless.yml path when nothing is found (produces a clear not-found error downstream)', () => {
      jest.mocked(fs.existsSync).mockReturnValue(false);
      expect(resolveConfigPath('/workspace', null)).toBe(path.join('/workspace', 'cfnless.yml'));
    });
  });

  describe('loadConfig with YAML', () => {
    it('parses a valid cfnless.yml and returns normalized config with all fields', () => {
      jest.mocked(fs.existsSync).mockReturnValue(true);
      jest.mocked(fs.readFileSync).mockReturnValue('yaml-content');
      jest.mocked(yaml.load).mockReturnValue(VALID_YAML_PARSED);

      const config = loadConfig('/workspace/cfnless.yml');

      expect(config.service).toBe('cf-abc123');
      expect(config.stage).toBe('dev');
      expect(config.provider.region).toBe('us-east-1');
      expect(config.provider.runtime).toBe('nodejs20.x');
      expect(config.provider.deploymentBucket).toBe('my-bucket');
      expect(config.provider.logRetentionInDays).toBe(14);
      expect(config.functions.api.image).toBe('123.dkr.ecr.us-east-1.amazonaws.com/repo:tag');
      expect((config.functions.api.url as { authorizer: string }).authorizer).toBe('aws_iam');
      expect((config.functions.api.url as { invokeMode: string }).invokeMode).toBe('RESPONSE_STREAM');
    });

    it('applies defaults for optional provider fields when omitted', () => {
      jest.mocked(fs.existsSync).mockReturnValue(true);
      jest.mocked(fs.readFileSync).mockReturnValue('yaml-content');
      jest.mocked(yaml.load).mockReturnValue({
        service: 'cf-abc123',
        provider: { name: 'aws', region: 'us-west-2' },
        functions: {},
      });

      const config = loadConfig('/workspace/cfnless.yml');

      expect(config.provider.runtime).toBe('nodejs20.x');
      expect(config.provider.logRetentionInDays).toBe(14);
      expect(config.provider.deploymentBucket).toBeNull();
      expect(config.provider.deploymentPrefix).toBe('serverless');
      expect(config.functions).toEqual({});
    });

    it('honors provider.deploymentPrefix override for S3 key prefix', () => {
      // Matches Serverless Framework's `deploymentPrefix` option so a cfnless.yml
      // copied from serverless.yml writes to the same S3 path the Framework would.
      jest.mocked(fs.existsSync).mockReturnValue(true);
      jest.mocked(fs.readFileSync).mockReturnValue('yaml-content');
      jest.mocked(yaml.load).mockReturnValue({
        service: 'cf-abc123',
        provider: { name: 'aws', region: 'us-east-1', deploymentPrefix: 'cfnless' },
        functions: {},
      });

      const config = loadConfig('/workspace/cfnless.yml');

      expect(config.provider.deploymentPrefix).toBe('cfnless');
    });

    it('throws when config file does not exist', () => {
      jest.mocked(fs.existsSync).mockReturnValue(false);

      expect(() => loadConfig('/workspace/cfnless.yml')).toThrow('Config file not found');
    });

    it('propagates yaml.load() errors for malformed YAML without swallowing them', () => {
      jest.mocked(fs.existsSync).mockReturnValue(true);
      jest.mocked(fs.readFileSync).mockReturnValue('yaml-content');
      jest.mocked(yaml.load).mockImplementation(() => { throw new Error('unexpected token at line 3'); });

      expect(() => loadConfig('/workspace/cfnless.yml')).toThrow('unexpected token at line 3');
    });

    it('throws when provider name is not aws', () => {
      jest.mocked(fs.existsSync).mockReturnValue(true);
      jest.mocked(fs.readFileSync).mockReturnValue('yaml-content');
      jest.mocked(yaml.load).mockReturnValue({
        service: 'my-service',
        provider: { name: 'azure', region: 'eastus' },
      });

      expect(() => loadConfig('/workspace/cfnless.yml')).toThrow('Only AWS provider is supported');
    });

    it('throws when region is missing', () => {
      jest.mocked(fs.existsSync).mockReturnValue(true);
      jest.mocked(fs.readFileSync).mockReturnValue('yaml-content');
      jest.mocked(yaml.load).mockReturnValue({
        service: 'my-service',
        provider: { name: 'aws' },
      });

      expect(() => loadConfig('/workspace/cfnless.yml')).toThrow('provider.region');
    });

    it('throws when service is missing', () => {
      jest.mocked(fs.existsSync).mockReturnValue(true);
      jest.mocked(fs.readFileSync).mockReturnValue('yaml-content');
      jest.mocked(yaml.load).mockReturnValue({
        provider: { name: 'aws', region: 'us-east-1' },
      });

      expect(() => loadConfig('/workspace/cfnless.yml')).toThrow('"service"');
    });

    it('sets deploymentBucket to null when deploymentBucket field is absent', () => {
      jest.mocked(fs.existsSync).mockReturnValue(true);
      jest.mocked(fs.readFileSync).mockReturnValue('yaml-content');
      jest.mocked(yaml.load).mockReturnValue({
        service: 'cf-abc123',
        provider: { name: 'aws', region: 'us-east-1' },
      });

      const config = loadConfig('/workspace/cfnless.yml');

      expect(config.provider.deploymentBucket).toBeNull();
    });

    it('silently ignores Serverless Framework v3 fields (frameworkVersion, configValidationMode, plugins, custom, package, versionFunctions, deploymentMethod)', () => {
      // cfnless must parse configs that include Serverless Framework v3 fields without throwing —
      // these fields are irrelevant to direct SDK deployment.
      jest.mocked(fs.existsSync).mockReturnValue(true);
      jest.mocked(fs.readFileSync).mockReturnValue('yaml-content');
      jest.mocked(yaml.load).mockReturnValue({
        service: 'cf-abc123',
        frameworkVersion: '3',
        configValidationMode: 'warn',
        package: { individually: true },
        plugins: ['serverless-dotenv-plugin', 'serverless-bundle'],
        custom: { bundle: { linting: false, sourcemaps: false } },
        provider: {
          name: 'aws',
          region: 'us-east-1',
          runtime: 'nodejs20.x',
          versionFunctions: false,
          deploymentMethod: 'direct',
          deploymentBucket: { name: 'my-bucket' },
          logRetentionInDays: 14,
        },
        functions: {
          api: {
            image: '123.dkr.ecr.us-east-1.amazonaws.com/repo:env-dep',
            timeout: 30,
            memorySize: 2048,
            role: 'arn:aws:iam::123:role/role',
            url: { authorizer: 'aws_iam', invokeMode: 'RESPONSE_STREAM' },
            tags: { DeploymentUid: 'abc123' },
          },
        },
      });

      expect(() => loadConfig('/workspace/cfnless.yml')).not.toThrow();
      const config = loadConfig('/workspace/cfnless.yml');
      expect(config.service).toBe('cf-abc123');
      expect(config.provider.region).toBe('us-east-1');
      expect(config.provider.deploymentBucket).toBe('my-bucket');
      expect(config.functions.api.image).toBe('123.dkr.ecr.us-east-1.amazonaws.com/repo:env-dep');
    });

    it('passes url:{} (empty object) through to functions unchanged', () => {
      // When neither authorizer nor invokeMode is set, some tooling serializes url as `url: {}`.
      // cfnless must not throw and must pass the empty object to deploy for normalization.
      jest.mocked(fs.existsSync).mockReturnValue(true);
      jest.mocked(fs.readFileSync).mockReturnValue('yaml-content');
      jest.mocked(yaml.load).mockReturnValue({
        service: 'cf-abc123',
        provider: { name: 'aws', region: 'us-east-1', runtime: 'nodejs20.x', deploymentBucket: { name: 'bucket' } },
        functions: {
          api: {
            image: '123.dkr.ecr.us-east-1.amazonaws.com/repo:tag',
            timeout: 30,
            memorySize: 1024,
            role: 'arn:aws:iam::123:role/role',
            url: {},
            tags: {},
          },
        },
      });

      const config = loadConfig('/workspace/cfnless.yml');

      expect(config.functions.api.url).toEqual({});
    });

    it('parses custom.esbuild block with exclude (serverless-esbuild name) and returns it in config', () => {
      jest.mocked(fs.existsSync).mockReturnValue(true);
      jest.mocked(fs.readFileSync).mockReturnValue('yaml-content');
      jest.mocked(yaml.load).mockReturnValue({
        service: 'cf-abc123',
        provider: { name: 'aws', region: 'us-east-1' },
        functions: {},
        custom: {
          esbuild: {
            minify: true,
            sourcemap: 'inline',
            exclude: ['sharp', 'canvas'],
            tsconfig: 'tsconfig.build.json',
          },
        },
      });

      const config = loadConfig('/workspace/cfnless.yml');

      expect(config.custom?.esbuild).toEqual({
        minify: true,
        sourcemap: 'inline',
        exclude: ['sharp', 'canvas'],
        tsconfig: 'tsconfig.build.json',
      });
    });

    it('parses custom.esbuild block with external (esbuild-native alias) and returns it in config', () => {
      jest.mocked(fs.existsSync).mockReturnValue(true);
      jest.mocked(fs.readFileSync).mockReturnValue('yaml-content');
      jest.mocked(yaml.load).mockReturnValue({
        service: 'cf-abc123',
        provider: { name: 'aws', region: 'us-east-1' },
        functions: {},
        custom: { esbuild: { external: ['aws-sdk'] } },
      });

      const config = loadConfig('/workspace/cfnless.yml');

      expect(config.custom?.esbuild?.external).toEqual(['aws-sdk']);
    });

    it('returns no custom field when custom.esbuild is absent', () => {
      jest.mocked(fs.existsSync).mockReturnValue(true);
      jest.mocked(fs.readFileSync).mockReturnValue('yaml-content');
      jest.mocked(yaml.load).mockReturnValue({
        service: 'cf-abc123',
        provider: { name: 'aws', region: 'us-east-1' },
        functions: {},
      });

      const config = loadConfig('/workspace/cfnless.yml');

      expect(config.custom).toBeUndefined();
    });

    it('passes function tags through to functions unchanged', () => {
      // cfnless must preserve all tags defined in the config for tagging Lambda functions correctly.
      jest.mocked(fs.existsSync).mockReturnValue(true);
      jest.mocked(fs.readFileSync).mockReturnValue('yaml-content');
      jest.mocked(yaml.load).mockReturnValue({
        service: 'cf-abc123',
        provider: { name: 'aws', region: 'us-east-1' },
        functions: {
          api: {
            image: 'img:tag',
            timeout: 30,
            memorySize: 1024,
            role: 'r',
            url: {},
            tags: {
              Team: 'platform',
              Environment: 'production',
              ServiceName: 'my-api',
              DeploymentUid: 'dep-123',
              AppVersion: '1.2.3',
            },
          },
        },
      });

      const config = loadConfig('/workspace/cfnless.yml');

      expect(config.functions.api.tags).toEqual({
        Team: 'platform',
        Environment: 'production',
        ServiceName: 'my-api',
        DeploymentUid: 'dep-123',
        AppVersion: '1.2.3',
      });
    });
  });
});
