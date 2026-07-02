import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  DeleteCommand,
  BatchWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import type { ServiceDefinition } from '../core/types.js';
import { dailyFromMonthly } from './lib.js';

/**
 * AWS DynamoDB — free-tier-aware, metered shared client.
 *
 * AWS Always-Free DynamoDB: ~200M requests/month (25 RCU + 25 WCU provisioned).
 * These ingestion pipelines are infrequent and small-batch, so we set conservative
 * limits (ratePerMinute=30, monthlyCap=50_000) — the soft-fail fires far below the
 * free tier ceiling. All limits are env-overridable.
 *
 * Creds + region from env (never hardcoded):
 *   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION
 * Table names are also env-driven per pipeline.
 */

const monthlyCap = Number(process.env.DYNAMODB_MONTHLY_CAP ?? 50_000);
const dailyCap = Number(process.env.DYNAMODB_DAILY_CAP ?? dailyFromMonthly(monthlyCap));

// Lazy-initialised client — only created when a helper is first called, so the
// service file can be imported without live AWS credentials (e.g. in tests that
// mock the module).
let _docClient: DynamoDBDocumentClient | null = null;

function getClient(): DynamoDBDocumentClient {
  if (!_docClient) {
    const raw = new DynamoDBClient({
      region: process.env.AWS_REGION ?? 'eu-west-1',
      ...(process.env.AWS_ACCESS_KEY_ID
        ? {
            credentials: {
              accessKeyId: process.env.AWS_ACCESS_KEY_ID,
              secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? '',
            },
          }
        : {}),
    });
    _docClient = DynamoDBDocumentClient.from(raw, {
      marshallOptions: { removeUndefinedValues: true },
    });
  }
  return _docClient;
}

/** Reset the cached client (used in tests to inject a mock). */
export function _resetClient(mock?: DynamoDBDocumentClient): void {
  _docClient = mock ?? null;
}

// ---------------------------------------------------------------------------
// Helpers — call these via callService('dynamodb', () => dynamoGet(...))
// ---------------------------------------------------------------------------

export async function dynamoGet(
  table: string,
  key: Record<string, unknown>,
): Promise<Record<string, unknown> | undefined> {
  const result = await getClient().send(new GetCommand({ TableName: table, Key: key }));
  return result.Item as Record<string, unknown> | undefined;
}

export async function dynamoPut(
  table: string,
  item: Record<string, unknown>,
): Promise<void> {
  await getClient().send(new PutCommand({ TableName: table, Item: item }));
}

export async function dynamoQuery(
  table: string,
  params: {
    keyConditionExpression: string;
    expressionAttributeNames?: Record<string, string>;
    expressionAttributeValues: Record<string, unknown>;
    indexName?: string;
    limit?: number;
  },
): Promise<Record<string, unknown>[]> {
  const result = await getClient().send(
    new QueryCommand({
      TableName: table,
      KeyConditionExpression: params.keyConditionExpression,
      ExpressionAttributeNames: params.expressionAttributeNames,
      ExpressionAttributeValues: params.expressionAttributeValues,
      IndexName: params.indexName,
      Limit: params.limit,
    }),
  );
  return (result.Items ?? []) as Record<string, unknown>[];
}

export async function dynamoDelete(
  table: string,
  key: Record<string, unknown>,
): Promise<void> {
  await getClient().send(new DeleteCommand({ TableName: table, Key: key }));
}

/** Batch-write up to 25 items (DynamoDB hard limit per batch). */
export async function dynamoBatchWrite(
  table: string,
  items: Record<string, unknown>[],
): Promise<void> {
  if (items.length === 0) return;
  if (items.length > 25) throw new Error('dynamoBatchWrite: max 25 items per batch');
  await getClient().send(
    new BatchWriteCommand({
      RequestItems: {
        [table]: items.map((item) => ({ PutRequest: { Item: item } })),
      },
    }),
  );
}

const service: ServiceDefinition = {
  name: 'dynamodb',
  category: 'api',
  description: 'AWS DynamoDB — shared ingestion client (free-tier-aware).',
  ratePerMinute: Number(process.env.DYNAMODB_RATE_PER_MIN ?? 30),
  dailyCap,
  monthlyCap,
  paid: false,
};

export default service;
