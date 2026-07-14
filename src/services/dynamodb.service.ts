import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  DeleteCommand,
  BatchWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { defineService } from './lib.js';

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

// Lazy-initialised client — only created when a helper is first called, so the
// service file can be imported without live AWS credentials (e.g. in tests that
// mock the module).
let _docClient: DynamoDBDocumentClient | null = null;

function getClient(): DynamoDBDocumentClient {
  if (!_docClient) {
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;

    // Throw loudly if access key id is set but secret is missing
    if (accessKeyId && !secretAccessKey) {
      throw new Error(
        'AWS_ACCESS_KEY_ID is set but AWS_SECRET_ACCESS_KEY is missing. ' +
          'Set both env vars or neither — a missing secret will cause confusing signature errors.',
      );
    }

    const raw = new DynamoDBClient({
      region: process.env.AWS_REGION ?? 'eu-west-1',
      ...(accessKeyId && secretAccessKey
        ? {
            credentials: {
              accessKeyId,
              secretAccessKey,
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
  throw new Error(
    'dynamoPut is disabled — DynamoDB write functions are policy-gated off in this repo ' +
      '(see CLAUDE.md / src/services/CLAUDE.md). Explicit owner sign-off is required before ' +
      're-enabling this function.',
  );
  // Intentionally unreachable — kept for when the policy gate is lifted.
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

/** Scan an entire table (paginated internally past Scan's ~1MB-per-call limit). */
export async function dynamoScan(
  table: string,
  params?: {
    filterExpression?: string;
    expressionAttributeNames?: Record<string, string>;
    expressionAttributeValues?: Record<string, unknown>;
  },
): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await getClient().send(
      new ScanCommand({
        TableName: table,
        FilterExpression: params?.filterExpression,
        ExpressionAttributeNames: params?.expressionAttributeNames,
        ExpressionAttributeValues: params?.expressionAttributeValues,
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    items.push(...((result.Items ?? []) as Record<string, unknown>[]));
    exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);
  return items;
}

export async function dynamoDelete(
  table: string,
  key: Record<string, unknown>,
): Promise<void> {
  throw new Error(
    'dynamoDelete is disabled — DynamoDB write functions are policy-gated off in this repo ' +
      '(see CLAUDE.md / src/services/CLAUDE.md). Explicit owner sign-off is required before ' +
      're-enabling this function.',
  );
  // Intentionally unreachable — kept for when the policy gate is lifted.
}

/** Batch-write up to 25 items (DynamoDB hard limit per batch). */
export async function dynamoBatchWrite(
  table: string,
  items: Record<string, unknown>[],
): Promise<void> {
  throw new Error(
    'dynamoBatchWrite is disabled — DynamoDB write functions are policy-gated off in this repo ' +
      '(see CLAUDE.md / src/services/CLAUDE.md). Explicit owner sign-off is required before ' +
      're-enabling this function.',
  );
  // Intentionally unreachable — kept for when the policy gate is lifted.
  if (items.length > 25) throw new Error('dynamoBatchWrite: max 25 items per batch');
  await getClient().send(
    new BatchWriteCommand({
      RequestItems: {
        [table]: items.map((item) => ({ PutRequest: { Item: item } })),
      },
    }),
  );
}

const service = defineService({
  name: 'dynamodb',
  category: 'api',
  description: 'AWS DynamoDB — shared ingestion client (free-tier-aware).',
  envPrefix: 'DYNAMODB',
  ratePerMinute: { fallback: 30 },
  monthlyCap: { fallback: 50_000 },
  dailyCap: { fallback: 'monthly/30' },
  paid: false,
  cacheTtlMs: 79_200_000,
  rateLimitSource:
    'AWS DynamoDB Always Free tier (25 provisioned RCU/WCU) — see https://aws.amazon.com/free/ — ' +
    'comfortably covers the low ingestion volume here. ratePerMinute=30 / monthlyCap=50,000 are our ' +
    'own conservative estimates layered well under that free-tier ceiling, not a number AWS ' +
    'publishes as a hard per-minute limit.',
});

export default service;
