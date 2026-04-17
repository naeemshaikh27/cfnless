import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { S3Uploader } from '../../src/lib/s3-uploader';

// Requires: docker compose -f __tests__/integration/docker-compose.yml up -d --wait
//
// Tests S3Uploader cleanup methods against real MinIO. Verifies the flat-vs-nested key
// distinction: cfnless owns flat keys (api.zip), Serverless Framework owns nested keys
// (timestamped subdirectory layout).

const MINIO_ENDPOINT = 'http://localhost:9000';
const BUCKET = 'cfnless-test-bucket';
const REGION = 'us-east-1';
const PREFIX = 'serverless';
const STAGE = 'dev';

function makeMinioClient(): S3Client {
  return new S3Client({
    endpoint: MINIO_ENDPOINT,
    region: REGION,
    credentials: { accessKeyId: 'testuser', secretAccessKey: 'testpassword' },
    forcePathStyle: true,
  });
}

function makeUploader(): S3Uploader {
  const uploader = new S3Uploader(REGION);
  uploader.client = makeMinioClient();
  return uploader;
}

async function putKey(client: S3Client, key: string): Promise<void> {
  await client.send(
    new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: Buffer.from('test') })
  );
}

async function listKeysUnderPrefix(client: S3Client, prefix: string): Promise<string[]> {
  const result = await client.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix }));
  return (result.Contents ?? []).map((o) => o.Key!);
}

async function deleteAll(client: S3Client, keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await client.send(
    new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: keys.map((Key) => ({ Key })) } })
  );
}

describe('S3Uploader cleanup integration (Minio)', () => {
  const client = makeMinioClient();
  // Use a unique service name per test run so parallel runs don't collide
  const SERVICE = `s3cleanup-inttest-${Date.now()}`;
  const keyPrefix = `${PREFIX}/${SERVICE}/${STAGE}/`;

  // Flat keys — cfnless layout (no extra path segment after the stage prefix)
  const flatKey1 = `${keyPrefix}api.zip`;
  const flatKey2 = `${keyPrefix}worker.zip`;
  // Nested keys — Serverless Framework timestamped layout (subdirectory after stage prefix)
  const nestedKey1 = `${keyPrefix}2024-01-01T00-00-00/compiled-cloudformation-template.json`;
  const nestedKey2 = `${keyPrefix}2024-01-01T00-00-00/api.zip`;

  afterAll(async () => {
    const remaining = await listKeysUnderPrefix(client, keyPrefix);
    await deleteAll(client, remaining);
  });

  it('deleteServiceZips removes flat keys and leaves nested keys intact', async () => {
    await putKey(client, flatKey1);
    await putKey(client, flatKey2);
    await putKey(client, nestedKey1);
    await putKey(client, nestedKey2);

    await makeUploader().deleteServiceZips(BUCKET, SERVICE, STAGE, PREFIX);

    const remaining = await listKeysUnderPrefix(client, keyPrefix);
    expect(remaining).not.toContain(flatKey1);
    expect(remaining).not.toContain(flatKey2);
    expect(remaining).toContain(nestedKey1);
    expect(remaining).toContain(nestedKey2);

    await deleteAll(client, [nestedKey1, nestedKey2]);
  });

  it('deleteServerlessLegacyArtifacts removes nested keys and leaves flat keys intact', async () => {
    await putKey(client, flatKey1);
    await putKey(client, flatKey2);
    await putKey(client, nestedKey1);
    await putKey(client, nestedKey2);

    await makeUploader().deleteServerlessLegacyArtifacts(BUCKET, SERVICE, STAGE, PREFIX);

    const remaining = await listKeysUnderPrefix(client, keyPrefix);
    expect(remaining).toContain(flatKey1);
    expect(remaining).toContain(flatKey2);
    expect(remaining).not.toContain(nestedKey1);
    expect(remaining).not.toContain(nestedKey2);

    await deleteAll(client, [flatKey1, flatKey2]);
  });

  it('deleteServiceZips writes a "no artifacts" message when the prefix has no flat keys', async () => {
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await makeUploader().deleteServiceZips(BUCKET, `nonexistent-${Date.now()}`, STAGE, PREFIX);

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('No S3 artifacts found'));
    stderrSpy.mockRestore();
  });

  it('deleteServerlessLegacyArtifacts writes a "no legacy artifacts" message when the prefix has no nested keys', async () => {
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await makeUploader().deleteServerlessLegacyArtifacts(
      BUCKET,
      `nonexistent-${Date.now()}`,
      STAGE,
      PREFIX
    );

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('No legacy serverless artifacts found')
    );
    stderrSpy.mockRestore();
  });
});
