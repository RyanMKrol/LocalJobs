#!/usr/bin/env node
/*
 * create-dynamo-tables.mjs — create the DynamoDB tables for the local-jobs ingestion
 * pipelines (listens + projects). Idempotent: a table that already exists is left alone.
 *
 * Run from the repo root:
 *     node scripts/create-dynamo-tables.mjs            # create (skips existing)
 *     node scripts/create-dynamo-tables.mjs --dry-run  # print what it WOULD do, no AWS calls
 *
 * Creds + region + table names are read from the environment; if a `.env` file exists at
 * the repo root it is loaded first (only filling vars not already set). Needs:
 *   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION   (already in your .env)
 *   LISTENS_TABLE  (default "Listens"),  PROJECTS_TABLE (default "Projects")
 *
 * Billing: PAY_PER_REQUEST (on-demand) — no capacity to plan, scales to zero, and at a
 * personal sync's volume the cost is a few cents/year. To use the always-free provisioned
 * tier instead, change BILLING below (note: the 25 RCU/WCU free tier is SHARED across ALL
 * tables in the account, and you already have several).
 *
 * ⚠️ KEY SCHEMA IS PERMANENT — DynamoDB can't change a table's partition/sort key after
 * creation. The sync workflows MUST write items carrying these exact key attributes:
 *   Listens  : partition key `trackId` (S) + sort key `scrobbledAt` (N, epoch seconds)
 *              → the (track, scrobble-time) pair is unique, so a scrobble is never double-stored (T254).
 *   Projects : partition key `repoId` (S)
 *              → one item per repo, upserted/refreshed each run (T256).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DynamoDBClient,
  CreateTableCommand,
  DescribeTableCommand,
  waitUntilTableExists,
} from '@aws-sdk/client-dynamodb';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DRY_RUN = process.argv.includes('--dry-run');
const BILLING = 'PAY_PER_REQUEST'; // or 'PROVISIONED' (then add ProvisionedThroughput)

// ── Load .env (only vars not already in the environment) ─────────────────────
try {
  const env = readFileSync(resolve(REPO_ROOT, '.env'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, k, vRaw] = m;
    if (process.env[k] === undefined) process.env[k] = vRaw.replace(/^["']|["']$/g, '');
  }
} catch { /* no .env — rely on the ambient environment */ }

const REGION = process.env.AWS_REGION;
const LISTENS = process.env.LISTENS_TABLE || 'Listens';
const PROJECTS = process.env.PROJECTS_TABLE || 'Projects';

// ── Table definitions ────────────────────────────────────────────────────────
const tables = [
  {
    TableName: LISTENS,
    BillingMode: BILLING,
    AttributeDefinitions: [
      { AttributeName: 'trackId', AttributeType: 'S' },
      { AttributeName: 'scrobbledAt', AttributeType: 'N' },
    ],
    KeySchema: [
      { AttributeName: 'trackId', KeyType: 'HASH' },
      { AttributeName: 'scrobbledAt', KeyType: 'RANGE' },
    ],
  },
  {
    TableName: PROJECTS,
    BillingMode: BILLING,
    AttributeDefinitions: [{ AttributeName: 'repoId', AttributeType: 'S' }],
    KeySchema: [{ AttributeName: 'repoId', KeyType: 'HASH' }],
  },
];

function describeKeys(def) {
  return def.KeySchema.map((k) => `${k.AttributeName} (${k.KeyType === 'HASH' ? 'partition' : 'sort'})`).join(' + ');
}

async function main() {
  console.log(`Region: ${REGION || '(unset!)'}   Billing: ${BILLING}`);
  for (const def of tables) console.log(`  • ${def.TableName}: ${describeKeys(def)}`);
  console.log('');

  if (!REGION) { console.error('✗ AWS_REGION is not set (check your .env). Aborting.'); process.exit(1); }
  if (DRY_RUN) { console.log('--dry-run: no AWS calls made. Re-run without --dry-run to create.'); return; }
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    console.error('✗ AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY not set (check your .env). Aborting.');
    process.exit(1);
  }

  const client = new DynamoDBClient({ region: REGION });
  let created = 0;
  for (const def of tables) {
    try {
      await client.send(new DescribeTableCommand({ TableName: def.TableName }));
      console.log(`✓ ${def.TableName} already exists — skipping.`);
      continue;
    } catch (e) {
      if (e?.name !== 'ResourceNotFoundException') throw e; // a real error (creds/perms) — surface it
    }
    console.log(`… creating ${def.TableName} …`);
    await client.send(new CreateTableCommand(def));
    await waitUntilTableExists({ client, maxWaitTime: 120 }, { TableName: def.TableName });
    console.log(`✓ ${def.TableName} created and ACTIVE.`);
    created++;
  }
  console.log(`\nDone — ${created} table(s) created. Now set in .env:`);
  console.log(`  LISTENS_TABLE=${LISTENS}`);
  console.log(`  PROJECTS_TABLE=${PROJECTS}`);
}

main().catch((e) => { console.error(`✗ ${e?.name || 'Error'}: ${e?.message || e}`); process.exit(1); });
