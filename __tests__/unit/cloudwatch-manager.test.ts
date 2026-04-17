import {
  CloudWatchLogsClient,
  CreateLogGroupCommand,
  PutRetentionPolicyCommand,
  DeleteLogGroupCommand,
  DescribeLogGroupsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import { CloudWatchManager } from '../../src/lib/cloudwatch-manager';

jest.mock('@aws-sdk/client-cloudwatch-logs');

describe('CloudWatchManager', () => {
  let mockSend: jest.Mock;
  let manager: CloudWatchManager;

  beforeEach(() => {
    jest.resetAllMocks();
    mockSend = jest.fn();
    jest.mocked(CloudWatchLogsClient).mockImplementation(() => ({ send: mockSend }) as unknown as CloudWatchLogsClient);
    manager = new CloudWatchManager('us-east-1');
  });

  describe('createLogGroupIfNotExists', () => {
    it('creates log group and sets retention when group does not exist, then skips create but still sets retention on second call', async () => {
      mockSend
        .mockResolvedValueOnce({ logGroups: [] })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ logGroups: [{ logGroupName: '/aws/lambda/my-fn' }] })
        .mockResolvedValueOnce({});

      await manager.createLogGroupIfNotExists('/aws/lambda/my-fn', 14);

      expect(mockSend.mock.calls[1][0]).toBeInstanceOf(CreateLogGroupCommand);
      expect(mockSend.mock.calls[2][0]).toBeInstanceOf(PutRetentionPolicyCommand);

      await manager.createLogGroupIfNotExists('/aws/lambda/my-fn', 14);

      expect(mockSend).toHaveBeenCalledTimes(5);
      expect(mockSend.mock.calls[4][0]).toBeInstanceOf(PutRetentionPolicyCommand);
    });

    it('handles ResourceAlreadyExistsException race condition gracefully and still sets retention', async () => {
      const alreadyExists = Object.assign(new Error('already exists'), { name: 'ResourceAlreadyExistsException' });

      mockSend
        .mockResolvedValueOnce({ logGroups: [] })
        .mockRejectedValueOnce(alreadyExists)
        .mockResolvedValueOnce({});

      await expect(manager.createLogGroupIfNotExists('/aws/lambda/my-fn', 14)).resolves.toBeUndefined();
      expect(mockSend.mock.calls[2][0]).toBeInstanceOf(PutRetentionPolicyCommand);
    });

    it('propagates unexpected errors from CreateLogGroup', async () => {
      const unexpected = Object.assign(new Error('throttled'), { name: 'ThrottlingException' });

      mockSend
        .mockResolvedValueOnce({ logGroups: [] })
        .mockRejectedValueOnce(unexpected);

      await expect(manager.createLogGroupIfNotExists('/aws/lambda/my-fn', 14)).rejects.toThrow(
        'Failed to create log group'
      );
    });
  });

  describe('deleteLogGroup', () => {
    it('sends DeleteLogGroupCommand for the given log group name', async () => {
      mockSend.mockResolvedValueOnce({});

      await manager.deleteLogGroup('/aws/lambda/my-fn');

      expect(mockSend).toHaveBeenCalledWith(expect.any(DeleteLogGroupCommand));
    });

    it('silently succeeds when log group does not exist (ResourceNotFoundException)', async () => {
      const notFound = Object.assign(new Error('not found'), { name: 'ResourceNotFoundException' });
      mockSend.mockRejectedValueOnce(notFound);

      await expect(manager.deleteLogGroup('/aws/lambda/my-fn')).resolves.toBeUndefined();
    });

    it('propagates unexpected delete errors', async () => {
      const err = Object.assign(new Error('access denied'), { name: 'AccessDeniedException' });
      mockSend.mockRejectedValueOnce(err);

      await expect(manager.deleteLogGroup('/aws/lambda/my-fn')).rejects.toThrow(
        'Failed to delete log group'
      );
    });
  });
});
