import {
  CloudWatchLogsClient,
  CreateLogGroupCommand,
  PutRetentionPolicyCommand,
  DeleteLogGroupCommand,
  DescribeLogGroupsCommand,
} from '@aws-sdk/client-cloudwatch-logs';

export class CloudWatchManager {
  client: CloudWatchLogsClient;

  constructor(region: string) {
    this.client = new CloudWatchLogsClient({
      region,
      maxAttempts: 3,
    });
  }

  async createLogGroupIfNotExists(logGroupName: string, retentionDays: number): Promise<void> {
    const exists = await this._logGroupExists(logGroupName);

    if (!exists) {
      try {
        await this.client.send(new CreateLogGroupCommand({ logGroupName }));
      } catch (err) {
        if (err.name === 'ResourceAlreadyExistsException') {
          // Race condition: created between our check and create — that's fine
        } else {
          throw new Error(`Failed to create log group ${logGroupName}: ${err.message}`);
        }
      }
    }

    try {
      await this.client.send(
        new PutRetentionPolicyCommand({
          logGroupName,
          retentionInDays: retentionDays,
        })
      );
    } catch (err) {
      throw new Error(`Failed to set retention on log group ${logGroupName}: ${err.message}`);
    }
  }

  async deleteLogGroup(logGroupName: string): Promise<void> {
    try {
      await this.client.send(new DeleteLogGroupCommand({ logGroupName }));
    } catch (err) {
      if (err.name === 'ResourceNotFoundException') {
        // Already gone — not an error
        return;
      }
      throw new Error(`Failed to delete log group ${logGroupName}: ${err.message}`);
    }
  }

  private async _logGroupExists(logGroupName: string): Promise<boolean> {
    try {
      const result = await this.client.send(
        new DescribeLogGroupsCommand({ logGroupNamePrefix: logGroupName, limit: 1 })
      );
      return (result.logGroups ?? []).some((g) => g.logGroupName === logGroupName);
    } catch (err) {
      throw new Error(`Failed to describe log group ${logGroupName}: ${err.message}`);
    }
  }
}
