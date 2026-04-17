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
  type Runtime,
} from '@aws-sdk/client-lambda';
import type { ContainerFunctionParams, ZipFunctionParams, NormalizedURLConfig } from '../types';

const WAIT_TIMEOUT_SECONDS = 300;
const WAIT_MIN_DELAY = 5;
const WAIT_MAX_DELAY = 30;

export class LambdaManager {
  client: LambdaClient;
  region: string;

  constructor(region: string) {
    this.client = new LambdaClient({
      region,
      maxAttempts: 3,
    });
    this.region = region;
  }

  async getFunction(functionName: string) {
    try {
      const result = await this.client.send(new GetFunctionCommand({ FunctionName: functionName }));
      return result;
    } catch (err) {
      if (err.name === 'ResourceNotFoundException') {
        return null;
      }
      throw err;
    }
  }

  async createOrUpdateContainerFunction(
    functionName: string,
    config: ContainerFunctionParams
  ): Promise<void> {
    const { image, role, timeout, memorySize, urlConfig, tags } = config;

    const existing = await this.getFunction(functionName);

    if (!existing) {
      process.stderr.write(`  Creating Lambda function: ${functionName}\n`);
      await this.client.send(
        new CreateFunctionCommand({
          FunctionName: functionName,
          PackageType: 'Image',
          Code: { ImageUri: image },
          Role: role,
          Timeout: timeout,
          MemorySize: memorySize,
          Tags: tags,
        })
      );
      await this._waitForActive(functionName);
    } else {
      process.stderr.write(`  Updating Lambda function: ${functionName}\n`);
      await this.client.send(
        new UpdateFunctionCodeCommand({
          FunctionName: functionName,
          ImageUri: image,
        })
      );
      await this._waitForUpdated(functionName);

      await this.client.send(
        new UpdateFunctionConfigurationCommand({
          FunctionName: functionName,
          Role: role,
          Timeout: timeout,
          MemorySize: memorySize,
        })
      );
      await this._waitForUpdated(functionName);
    }

    await this._tagFunction(functionName, tags);
    await this._upsertFunctionUrl(functionName, urlConfig);
  }

  async createOrUpdateZipFunction(
    functionName: string,
    config: ZipFunctionParams
  ): Promise<void> {
    const { s3Bucket, s3Key, handler, role, timeout, memorySize, runtime, environment, urlConfig, tags } =
      config;

    const existing = await this.getFunction(functionName);

    if (!existing) {
      process.stderr.write(`  Creating Lambda function: ${functionName}\n`);
      await this.client.send(
        new CreateFunctionCommand({
          FunctionName: functionName,
          PackageType: 'Zip',
          Code: { S3Bucket: s3Bucket, S3Key: s3Key },
          Handler: handler,
          Runtime: runtime as Runtime,
          Role: role,
          Timeout: timeout,
          MemorySize: memorySize,
          Environment: { Variables: environment || {} },
          Tags: tags,
        })
      );
      await this._waitForActive(functionName);
    } else {
      process.stderr.write(`  Updating Lambda function: ${functionName}\n`);
      await this.client.send(
        new UpdateFunctionCodeCommand({
          FunctionName: functionName,
          S3Bucket: s3Bucket,
          S3Key: s3Key,
        })
      );
      await this._waitForUpdated(functionName);

      await this.client.send(
        new UpdateFunctionConfigurationCommand({
          FunctionName: functionName,
          Handler: handler,
          Runtime: runtime as Runtime,
          Role: role,
          Timeout: timeout,
          MemorySize: memorySize,
          Environment: { Variables: environment || {} },
        })
      );
      await this._waitForUpdated(functionName);
    }

    await this._tagFunction(functionName, tags);
    await this._upsertFunctionUrl(functionName, urlConfig);
  }

  async getFunctionUrl(functionName: string): Promise<string | null> {
    try {
      const result = await this.client.send(
        new GetFunctionUrlConfigCommand({ FunctionName: functionName })
      );
      return result.FunctionUrl ?? null;
    } catch (err) {
      if (err.name === 'ResourceNotFoundException') {
        return null;
      }
      throw err;
    }
  }

  async deleteFunction(functionName: string): Promise<void> {
    try {
      await this.client.send(new DeleteFunctionCommand({ FunctionName: functionName }));
      process.stderr.write(`  Deleted Lambda function: ${functionName}\n`);
    } catch (err) {
      if (err.name === 'ResourceNotFoundException') {
        process.stdout.write(`Function ${functionName} does not exist — skipping\n`);
        return;
      }
      throw err;
    }
  }

  private async _upsertFunctionUrl(
    functionName: string,
    urlConfig: NormalizedURLConfig | null | undefined
  ): Promise<void> {
    if (urlConfig === null || urlConfig === undefined) return;

    const authType = urlConfig.authorizer === 'aws_iam' ? 'AWS_IAM' : 'NONE';
    const invokeMode = urlConfig.invokeMode === 'RESPONSE_STREAM' ? 'RESPONSE_STREAM' : 'BUFFERED';

    let existingUrl: { AuthType?: string; InvokeMode?: string } | undefined;
    try {
      const result = await this.client.send(
        new GetFunctionUrlConfigCommand({ FunctionName: functionName })
      );
      existingUrl = result;
    } catch (err) {
      if (err.name !== 'ResourceNotFoundException') {
        throw err;
      }
    }

    if (!existingUrl) {
      await this.client.send(
        new CreateFunctionUrlConfigCommand({
          FunctionName: functionName,
          AuthType: authType,
          InvokeMode: invokeMode,
        })
      );
    } else if (existingUrl.AuthType !== authType || existingUrl.InvokeMode !== invokeMode) {
      await this.client.send(
        new UpdateFunctionUrlConfigCommand({
          FunctionName: functionName,
          AuthType: authType,
          InvokeMode: invokeMode,
        })
      );
    }

    if (authType === 'NONE') {
      await this._addPublicUrlPolicy(functionName);
    }
  }

  private async _addPublicUrlPolicy(functionName: string): Promise<void> {
    try {
      await this.client.send(
        new AddPermissionCommand({
          FunctionName: functionName,
          StatementId: 'FunctionURLAllowPublicAccess',
          Action: 'lambda:InvokeFunctionUrl',
          Principal: '*',
          FunctionUrlAuthType: 'NONE',
        })
      );
    } catch (err) {
      if (err.name === 'ResourceConflictException') {
        // Permission already exists — that's fine
        return;
      }
      throw err;
    }
  }

  private async _tagFunction(
    functionName: string,
    tags: Record<string, string>
  ): Promise<void> {
    if (!tags || Object.keys(tags).length === 0) {
      return;
    }

    const funcDetails = await this.getFunction(functionName);
    if (!funcDetails) {
      return;
    }

    const arn = funcDetails.Configuration!.FunctionArn!;
    await this.client.send(new TagResourceCommand({ Resource: arn, Tags: tags }));
  }

  private async _waitForActive(functionName: string): Promise<void> {
    try {
      await waitUntilFunctionActiveV2(
        {
          client: this.client,
          maxWaitTime: WAIT_TIMEOUT_SECONDS,
          minDelay: WAIT_MIN_DELAY,
          maxDelay: WAIT_MAX_DELAY,
        },
        { FunctionName: functionName }
      );
    } catch (err) {
      throw new Error(`Lambda function ${functionName} did not become active: ${err.message}`);
    }
  }

  private async _waitForUpdated(functionName: string): Promise<void> {
    try {
      await waitUntilFunctionUpdated(
        {
          client: this.client,
          maxWaitTime: WAIT_TIMEOUT_SECONDS,
          minDelay: WAIT_MIN_DELAY,
          maxDelay: WAIT_MAX_DELAY,
        },
        { FunctionName: functionName }
      );
    } catch (err) {
      throw new Error(`Lambda function ${functionName} did not finish updating: ${err.message}`);
    }
  }
}
