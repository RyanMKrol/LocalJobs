// Whole-repo invariant: every job that declares inputKeys() must also declare
// inputKeysService naming a real, registered service. This is the mechanical
// enforcement of that convention — a future job shipped with inputKeys() but no
// inputKeysService must fail `npm test`, not just leave a documentation gap
// someone happens to notice. Depends on T487 (the field and retrofit are
// prerequisites).
import assert from 'node:assert/strict';
import { jobs, services } from '../workflows/registry.js';

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e instanceof Error ? e.message : e}`);
    process.exitCode = 1;
  }
}

// ─────────────────────────── real-registry walk ───────────────────────────

test('every job with inputKeys() declares a valid inputKeysService', () => {
  const serviceNameSet = new Set(services.map((s) => s.name));

  for (const job of jobs) {
    if (!job.inputKeys) {
      // Job doesn't declare inputKeys() — no service required
      continue;
    }

    // Job declares inputKeys() — must also declare inputKeysService
    assert.ok(
      job.inputKeysService,
      `job '${job.name}' declares inputKeys() but has no inputKeysService field — ` +
        `add inputKeysService: '<service-name>' to the JobDefinition to name the service ` +
        `that inputKeys() queries through`,
    );

    // inputKeysService must name a real, registered service
    assert.ok(
      serviceNameSet.has(job.inputKeysService),
      `job '${job.name}' declares inputKeysService: '${job.inputKeysService}' ` +
        `but no service named '${job.inputKeysService}' is registered. ` +
        `Valid services: ${Array.from(serviceNameSet).sort().join(', ')}`,
    );
  }
});

console.log(`\n${passed} root-inputkeys-service test(s) passed`);
