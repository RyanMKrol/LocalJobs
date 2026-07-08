import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import service from './plex.service.js';

describe('plex service — unit', () => {
  it('service definition has expected shape', () => {
    assert.equal(service.name, 'plex');
    assert.equal(service.category, 'api');
    assert.equal(service.paid, false);
    assert.equal(service.ratePerMinute, undefined);
    assert.equal(service.dailyCap, undefined);
    assert.equal(service.monthlyCap, undefined);
    assert.equal(service.minIntervalMs, undefined);
    assert.equal(service.maxJitterMs, undefined);
    assert.ok(typeof service.description === 'string' && service.description.length > 0);
    assert.ok(typeof service.rateLimitSource === 'string' && service.rateLimitSource.length > 0);
  });
});
