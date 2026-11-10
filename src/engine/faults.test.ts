// The fault file: a waiting fault is handed out once per attempt and cleans up
// after itself, and anything unreadable is ignored.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { faultsFile, takeFault } from './faults.js';

const dir = mkdtempSync(join(tmpdir(), 'lj-faults-'));
let n = 0;
const fileWith = (body: string) => {
  const f = join(dir, `faults-${n++}.json`);
  writeFileSync(f, body);
  return f;
};

test('with no faults file nothing is injected, and the default file sits next to the database', () => {
  assert.equal(takeFault('any-job', join(dir, 'absent.json')), null);
  assert.match(faultsFile(), /engine-faults\.json$/);
});

test('a fault is handed to the named stage only, once per attempt, and the file is removed when spent', () => {
  const f = fileWith(JSON.stringify([{ job: 'a', fault: 'fail', attempts: 2 }, { job: 'b', fault: 'skip-outputs' }]));
  assert.equal(takeFault('c', f), null, 'another stage is untouched');
  assert.equal(takeFault('a', f), 'fail');
  assert.deepEqual(JSON.parse(readFileSync(f, 'utf8')), [{ job: 'a', fault: 'fail', attempts: 1 }, { job: 'b', fault: 'skip-outputs' }]);
  assert.equal(takeFault('a', f), 'fail');
  assert.equal(takeFault('a', f), null, 'used up after its two attempts');
  assert.equal(takeFault('b', f), 'skip-outputs');
  assert.equal(existsSync(f), false, 'an empty list deletes the file, so a fault cannot outlive its run');
});

test('a faults file that is not valid, or names an unknown fault, injects nothing', () => {
  assert.equal(takeFault('a', fileWith('{not json')), null);
  assert.equal(takeFault('a', fileWith('{"job":"a","fault":"fail"}')), null, 'must be a list');
  assert.equal(takeFault('a', fileWith(JSON.stringify([{ job: 'a', fault: 'explode' }]))), null);
});
