import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import fs from 'fs';

export class S3Uploader {
  client: S3Client;

  constructor(region: string) {
    this.client = new S3Client({
      region,
      maxAttempts: 3,
    });
  }

  async deleteServiceZips(
    bucket: string,
    service: string,
    stage: string,
    deploymentPrefix: string
  ): Promise<void> {
    const prefix = `${deploymentPrefix}/${service}/${stage}/`;
    const keys = await this.listKeys(bucket, prefix);
    // Keep only flat keys (cfnless's own layout). Nested keys belong to Serverless
    // Framework's timestamped layout and are cleaned only via --remove-serverless-s3-artifacts.
    const flatKeys = keys.filter((k) => !k.slice(prefix.length).includes('/'));

    if (flatKeys.length === 0) {
      process.stderr.write(`No S3 artifacts found at s3://${bucket}/${prefix}\n`);
      return;
    }

    await this.deleteKeys(bucket, flatKeys);
    process.stderr.write(`Deleted ${flatKeys.length} S3 artifact(s) from s3://${bucket}/${prefix}\n`);
  }

  async deleteServerlessLegacyArtifacts(
    bucket: string,
    service: string,
    stage: string,
    deploymentPrefix: string
  ): Promise<void> {
    const prefix = `${deploymentPrefix}/${service}/${stage}/`;
    const keys = await this.listKeys(bucket, prefix);
    const legacyKeys = keys.filter((k) => k.slice(prefix.length).includes('/'));

    if (legacyKeys.length === 0) {
      process.stderr.write(`No legacy serverless artifacts found at s3://${bucket}/${prefix}\n`);
      return;
    }

    await this.deleteKeys(bucket, legacyKeys);
    process.stderr.write(
      `Deleted ${legacyKeys.length} legacy serverless artifact(s) from s3://${bucket}/${prefix}\n`
    );
  }

  private async listKeys(bucket: string, prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let continuationToken: string | undefined;

    do {
      const command = new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
      });

      let result;
      try {
        result = await this.client.send(command);
      } catch (err) {
        throw new Error(`Failed to list S3 objects at s3://${bucket}/${prefix}: ${err.message}`);
      }

      for (const obj of result.Contents ?? []) {
        if (obj.Key) keys.push(obj.Key);
      }

      continuationToken = result.NextContinuationToken;
    } while (continuationToken);

    return keys;
  }

  private async deleteKeys(bucket: string, keys: string[]): Promise<void> {
    // DeleteObjects accepts at most 1000 keys per call
    const BATCH_SIZE = 1000;
    for (let i = 0; i < keys.length; i += BATCH_SIZE) {
      const batch = keys.slice(i, i + BATCH_SIZE);
      try {
        await this.client.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: batch.map((Key) => ({ Key })) },
          })
        );
      } catch (err) {
        throw new Error(`Failed to delete S3 objects from s3://${bucket}: ${err.message}`);
      }
    }
  }

  async uploadZip(zipFile: string, bucket: string | null, key: string): Promise<void> {
    if (!bucket) {
      throw new Error('Deployment bucket name is required for zip function deployments');
    }

    const body = fs.readFileSync(zipFile);

    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: 'application/zip',
        })
      );
    } catch (err) {
      throw new Error(`Failed to upload zip to s3://${bucket}/${key}: ${err.message}`);
    }
  }
}
