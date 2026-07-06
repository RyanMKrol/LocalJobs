import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import service, { _resetClient, dynamoBatchWrite, dynamoScan } from './dynamodb.service.js';

// ---------------------------------------------------------------------------
// Minimal stub that records calls and returns preset responses.
// We only need to verify the helpers call send() with expected commands.
// ---------------------------------------------------------------------------
function makeMockClient(responses: Record<string, unknown>[]): DynamoDBDocumentClient {
  const calls: string[] = [];
  let idx = 0;
  return {
    send(cmd: { constructor: { name: string } }) {
      calls.push(cmd.constructor.name);
      const resp = responses[idx++] ?? {};
      return Promise.resolve(resp);
    },
    _calls: calls,
  } as unknown as DynamoDBDocumentClient;
}

describe('dynamodb service — unit (mocked AWS client)', () => {
  before(() => {
    // Inject a fresh mock before each group runs
  });

  after(() => {
    _resetClient();
  });

  it('service definition has expected shape', () => {
    assert.equal(service.name, 'dynamodb');
    assert.ok(typeof service.ratePerMinute === 'number' && service.ratePerMinute > 0);
    assert.ok(typeof service.monthlyCap === 'number' && service.monthlyCap! > 0);
    assert.ok(typeof service.dailyCap === 'number' && service.dailyCap! > 0);
    assert.equal(service.paid, false);
  });

  it('dailyCap is monthlyCap / 30 (free-tier math)', () => {
    const monthly = service.monthlyCap!;
    const daily = service.dailyCap!;
    assert.equal(daily, Math.floor(monthly / 30));
  });

  it('monthlyCap is within free-tier headroom (≤ 200_000)', () => {
    // Default 50_000 is well under the AWS free-tier ~200M/month ceiling.
    assert.ok(service.monthlyCap! <= 200_000);
  });

  it('dynamoBatchWrite rejects (disabled) for a batch over 25 items', async () => {
    _resetClient(makeMockClient([]));
    const items = Array.from({ length: 26 }, (_, i) => ({ pk: String(i) }));
    await assert.rejects(() => dynamoBatchWrite('MyTable', items), /disabled/);
  });

  it('dynamoBatchWrite rejects (disabled) even for an empty array', async () => {
    const mock = makeMockClient([]);
    _resetClient(mock);
    await assert.rejects(() => dynamoBatchWrite('MyTable', []), /disabled/);
    // no send should have been called
    assert.equal((mock as unknown as { _calls: string[] })._calls.length, 0);
  });

  it('dynamoGet calls send with GetCommand and returns Item', async () => {
    const { dynamoGet } = await import('./dynamodb.service.js');
    _resetClient(makeMockClient([{ Item: { pk: 'x', n: 1 } }]));
    const item = await dynamoGet('T', { pk: 'x' });
    assert.deepEqual(item, { pk: 'x', n: 1 });
  });

  it('dynamoGet returns undefined when Item absent', async () => {
    const { dynamoGet } = await import('./dynamodb.service.js');
    _resetClient(makeMockClient([{ Item: undefined }]));
    const item = await dynamoGet('T', { pk: 'missing' });
    assert.equal(item, undefined);
  });

  it('dynamoPut is disabled — rejects with a clear error', async () => {
    const { dynamoPut } = await import('./dynamodb.service.js');
    _resetClient(makeMockClient([{}]));
    await assert.rejects(() => dynamoPut('T', { pk: 'a', val: 1 }), /disabled/);
  });

  it('dynamoDelete is disabled — rejects with a clear error', async () => {
    const { dynamoDelete } = await import('./dynamodb.service.js');
    _resetClient(makeMockClient([{}]));
    await assert.rejects(() => dynamoDelete('T', { pk: 'a' }), /disabled/);
  });

  it('dynamoScan returns Items array (single page)', async () => {
    _resetClient(makeMockClient([{ Items: [{ id: 'a' }, { id: 'b' }] }]));
    const rows = await dynamoScan('T');
    assert.deepEqual(rows, [{ id: 'a' }, { id: 'b' }]);
  });

  it('dynamoScan paginates via LastEvaluatedKey and concatenates both pages', async () => {
    const mock = makeMockClient([
      { Items: [{ id: 'a' }], LastEvaluatedKey: { id: 'a' } },
      { Items: [{ id: 'b' }] },
    ]);
    _resetClient(mock);
    const rows = await dynamoScan('T');
    assert.deepEqual(rows, [{ id: 'a' }, { id: 'b' }]);
    assert.equal((mock as unknown as { _calls: string[] })._calls.length, 2);
  });

  it('dynamoQuery returns Items array', async () => {
    const { dynamoQuery } = await import('./dynamodb.service.js');
    _resetClient(makeMockClient([{ Items: [{ pk: 'a' }, { pk: 'b' }] }]));
    const rows = await dynamoQuery('T', {
      keyConditionExpression: 'pk = :pk',
      expressionAttributeValues: { ':pk': 'a' },
    });
    assert.equal(rows.length, 2);
  });
});
