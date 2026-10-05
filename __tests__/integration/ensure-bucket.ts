import { S3Client, CreateBucketCommand } from '@aws-sdk/client-s3';

// Creates the bucket if it does not exist yet. Safe to call from several test files
// running in parallel against the same LocalStack instance.
export async function ensureBucket(client: S3Client, bucket: string): Promise<void> {
  try {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name !== 'BucketAlreadyOwnedByYou' && name !== 'BucketAlreadyExists') throw err;
  }
}
