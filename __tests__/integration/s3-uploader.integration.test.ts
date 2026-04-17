import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { S3Uploader } from '../../src/lib/s3-uploader';

// Requires: docker compose -f __tests__/integration/docker-compose.yml up -d --wait

const MINIO_ENDPOINT = 'http://localhost:9000';
const BUCKET = 'cfnless-test-bucket';
const REGION = 'us-east-1';

function makeMinioClient() {
  return new S3Client({
    endpoint: MINIO_ENDPOINT,
    region: REGION,
    credentials: { accessKeyId: 'testuser', secretAccessKey: 'testpassword' },
    forcePathStyle: true,
  });
}

describe('S3Uploader integration (Minio)', () => {
  let tmpZip: string;

  beforeAll(() => {
    tmpZip = path.join(os.tmpdir(), 'cfnless-integration-test.zip');
    // Minimal valid ZIP file (empty central directory)
    fs.writeFileSync(tmpZip, Buffer.from('PK\x05\x06' + '\x00'.repeat(18)));
  });

  afterAll(() => {
    if (fs.existsSync(tmpZip)) fs.unlinkSync(tmpZip);
  });

  it('uploads a zip file to Minio and the object is retrievable with correct ContentType', async () => {
    const uploader = new S3Uploader(REGION);
    uploader.client = makeMinioClient();

    const key = `integration-test/upload-${Date.now()}.zip`;

    await uploader.uploadZip(tmpZip, BUCKET, key);

    const result = await makeMinioClient().send(
      new GetObjectCommand({ Bucket: BUCKET, Key: key })
    );
    expect(result.ContentType).toBe('application/zip');
  });

  it('throws a descriptive s3:// error when bucket does not exist', async () => {
    const uploader = new S3Uploader(REGION);
    uploader.client = makeMinioClient();

    await expect(
      uploader.uploadZip(tmpZip, 'non-existent-bucket-cfnless', 'key.zip')
    ).rejects.toThrow('s3://non-existent-bucket-cfnless/key.zip');
  });

  it('throws before calling AWS when bucket argument is null', async () => {
    const uploader = new S3Uploader(REGION);
    uploader.client = makeMinioClient();

    await expect(uploader.uploadZip(tmpZip, null, 'key.zip')).rejects.toThrow(
      'Deployment bucket name is required'
    );
  });
});
