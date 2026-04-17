import {
  CloudWatchLogsClient,
  DescribeLogGroupsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import { CloudWatchManager } from '../../src/lib/cloudwatch-manager';

// Requires: docker compose -f __tests__/integration/docker-compose.yml up -d --wait

const LOCALSTACK_ENDPOINT = 'http://localhost:4566';
const REGION = 'us-east-1';

function makeLocalStackCWClient() {
  return new CloudWatchLogsClient({
    endpoint: LOCALSTACK_ENDPOINT,
    region: REGION,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
}

function makeManager() {
  const manager = new CloudWatchManager(REGION);
  manager.client = makeLocalStackCWClient();
  return manager;
}

describe('CloudWatchManager integration (LocalStack)', () => {
  const LOG_GROUP = `/aws/lambda/cfnless-integration-test-${Date.now()}`;
  const manager = makeManager();

  afterAll(async () => {
    await manager.deleteLogGroup(LOG_GROUP).catch(() => {});
  });

  it('creates a log group, verifies retention is set, then deletes it', async () => {
    await manager.createLogGroupIfNotExists(LOG_GROUP, 14);

    const result = await makeLocalStackCWClient().send(
      new DescribeLogGroupsCommand({ logGroupNamePrefix: LOG_GROUP })
    );
    const group = result.logGroups!.find((g) => g.logGroupName === LOG_GROUP);
    expect(group).toBeDefined();
    expect(group!.retentionInDays).toBe(14);

    await manager.deleteLogGroup(LOG_GROUP);

    const afterDelete = await makeLocalStackCWClient().send(
      new DescribeLogGroupsCommand({ logGroupNamePrefix: LOG_GROUP })
    );
    expect(afterDelete.logGroups!.find((g) => g.logGroupName === LOG_GROUP)).toBeUndefined();
  });

  it('is idempotent — calling createLogGroupIfNotExists twice does not throw', async () => {
    const idempotentGroup = `${LOG_GROUP}-idempotent`;

    await manager.createLogGroupIfNotExists(idempotentGroup, 7);
    await expect(manager.createLogGroupIfNotExists(idempotentGroup, 7)).resolves.toBeUndefined();

    await manager.deleteLogGroup(idempotentGroup);
  });

  it('deleteLogGroup resolves silently when log group does not exist', async () => {
    await expect(
      manager.deleteLogGroup('/aws/lambda/cfnless-definitely-does-not-exist')
    ).resolves.toBeUndefined();
  });

  it('updates retention policy when called a second time with a different value', async () => {
    const retentionGroup = `${LOG_GROUP}-retention`;

    await manager.createLogGroupIfNotExists(retentionGroup, 7);
    await manager.createLogGroupIfNotExists(retentionGroup, 30);

    const result = await makeLocalStackCWClient().send(
      new DescribeLogGroupsCommand({ logGroupNamePrefix: retentionGroup })
    );
    const group = result.logGroups!.find((g) => g.logGroupName === retentionGroup);
    expect(group!.retentionInDays).toBe(30);

    await manager.deleteLogGroup(retentionGroup);
  });
});
