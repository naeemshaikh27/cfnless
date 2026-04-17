import fs from 'fs';
import { loadConfig } from '../../src/lib/config-loader';

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

      expect(config.provider.runtime).toBe('nodejs18.x');
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
