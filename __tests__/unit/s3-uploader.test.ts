import { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import fs from 'fs';
import { S3Uploader } from '../../src/lib/s3-uploader';

jest.mock('@aws-sdk/client-s3');
jest.mock('fs');

describe('S3Uploader', () => {
  let mockSend: jest.Mock;
  let uploader: S3Uploader;

  beforeEach(() => {
    jest.resetAllMocks();
    mockSend = jest.fn();
    jest.mocked(S3Client).mockImplementation(() => ({ send: mockSend }) as unknown as S3Client);
    jest.mocked(fs.readFileSync).mockReturnValue(Buffer.from('fake-zip-content'));
    uploader = new S3Uploader('us-east-1');
  });

  it('uploads zip file to the correct S3 bucket, key, and content-type', async () => {
    mockSend.mockResolvedValueOnce({});

    await uploader.uploadZip('/tmp/bundle.zip', 'my-bucket', 'service/zips/fn.zip');

    expect(mockSend).toHaveBeenCalledWith(expect.any(PutObjectCommand));
    const constructorInput = jest.mocked(PutObjectCommand).mock.calls[0][0];
    expect(constructorInput.Bucket).toBe('my-bucket');
    expect(constructorInput.Key).toBe('service/zips/fn.zip');
    expect(constructorInput.ContentType).toBe('application/zip');
    expect(fs.readFileSync).toHaveBeenCalledWith('/tmp/bundle.zip');
  });

  it('throws with a meaningful error message when bucket is not provided', async () => {
    await expect(uploader.uploadZip('/tmp/bundle.zip', null, 'key')).rejects.toThrow(
      'Deployment bucket name is required'
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('throws when bucket is an empty string', async () => {
    await expect(uploader.uploadZip('/tmp/bundle.zip', '', 'key')).rejects.toThrow(
      'Deployment bucket name is required'
    );
  });

  it('wraps AWS errors with the s3:// URI for easier debugging', async () => {
    mockSend.mockRejectedValueOnce(new Error('Access Denied'));

    await expect(uploader.uploadZip('/tmp/bundle.zip', 'my-bucket', 'service/key.zip')).rejects.toThrow(
      's3://my-bucket/service/key.zip'
    );
  });

  describe('deleteServiceZips (flat cfnless keys only)', () => {
    // ListObjectsV2 returns every object under `serverless/<svc>/<stage>/`.
    // deleteServiceZips must delete only cfnless-style flat keys so serverless's
    // timestamped artifacts are left for --remove-serverless-s3-artifacts.
    const FLAT_KEY = 'serverless/svc/dev/svc-dev-worker.zip';
    const NESTED_KEY = 'serverless/svc/dev/1776435981028-2026-04-17/handler.zip';

    it('deletes only flat keys, leaving nested (legacy) keys untouched', async () => {
      mockSend
        .mockResolvedValueOnce({
          Contents: [{ Key: FLAT_KEY }, { Key: NESTED_KEY }],
          NextContinuationToken: undefined,
        })
        .mockResolvedValueOnce({});

      await uploader.deleteServiceZips('my-bucket', 'svc', 'dev', 'serverless');

      const deleteInput = jest.mocked(DeleteObjectsCommand).mock.calls[0][0];
      expect(deleteInput.Delete?.Objects).toEqual([{ Key: FLAT_KEY }]);
    });

    it('writes "No S3 artifacts found" and skips DeleteObjects when only nested keys exist', async () => {
      mockSend.mockResolvedValueOnce({
        Contents: [{ Key: NESTED_KEY }],
        NextContinuationToken: undefined,
      });
      const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);

      await uploader.deleteServiceZips('my-bucket', 'svc', 'dev', 'serverless');

      expect(jest.mocked(DeleteObjectsCommand).mock.calls).toHaveLength(0);
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('No S3 artifacts found'));
      stderrSpy.mockRestore();
    });

    it('uses the correct prefix when listing', async () => {
      mockSend.mockResolvedValueOnce({ Contents: [], NextContinuationToken: undefined });

      await uploader.deleteServiceZips('my-bucket', 'svc', 'dev', 'serverless');

      const listInput = jest.mocked(ListObjectsV2Command).mock.calls[0][0];
      expect(listInput.Bucket).toBe('my-bucket');
      expect(listInput.Prefix).toBe('serverless/svc/dev/');
    });
  });

  describe('deleteServerlessLegacyArtifacts (nested keys only)', () => {
    const FLAT_KEY = 'serverless/svc/dev/svc-dev-worker.zip';
    const NESTED_KEY = 'serverless/svc/dev/1776435981028-2026-04-17/handler.zip';
    const NESTED_KEY_2 = 'serverless/svc/dev/1776435981030-2026-04-18/handler.zip';

    it('deletes only nested (legacy) keys, leaving flat cfnless keys untouched', async () => {
      mockSend
        .mockResolvedValueOnce({
          Contents: [{ Key: FLAT_KEY }, { Key: NESTED_KEY }, { Key: NESTED_KEY_2 }],
          NextContinuationToken: undefined,
        })
        .mockResolvedValueOnce({});

      await uploader.deleteServerlessLegacyArtifacts('my-bucket', 'svc', 'dev', 'serverless');

      const deleteInput = jest.mocked(DeleteObjectsCommand).mock.calls[0][0];
      expect(deleteInput.Delete?.Objects).toEqual([{ Key: NESTED_KEY }, { Key: NESTED_KEY_2 }]);
    });

    it('writes "No legacy serverless artifacts found" and skips DeleteObjects when none match', async () => {
      mockSend.mockResolvedValueOnce({
        Contents: [{ Key: FLAT_KEY }],
        NextContinuationToken: undefined,
      });
      const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);

      await uploader.deleteServerlessLegacyArtifacts('my-bucket', 'svc', 'dev', 'serverless');

      expect(jest.mocked(DeleteObjectsCommand).mock.calls).toHaveLength(0);
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining('No legacy serverless artifacts found')
      );
      stderrSpy.mockRestore();
    });
  });
});
