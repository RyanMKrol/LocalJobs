// Regression guard for loadPerfumes() reading live from the PerfumeRatings
// DynamoDB table (T401) instead of the retired local perfumes.json file.
// Hermetic: injects a mock DynamoDB doc client via the shared service module's
// _resetClient (no live AWS call); callService('dynamodb', ...) runs ungated
// in this test process since no *.service.ts registry sync has run.
import assert from 'node:assert/strict';
import { describe, it, after } from 'node:test';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { _resetClient } from '../../services/dynamodb.service.js';
import { loadPerfumes } from './lib.js';

function makeMockClient(items: Record<string, unknown>[]): DynamoDBDocumentClient {
  return {
    send() {
      return Promise.resolve({ Items: items });
    },
  } as unknown as DynamoDBDocumentClient;
}

describe('loadPerfumes — reads live from PerfumeRatings (T401)', () => {
  after(() => {
    _resetClient();
  });

  it('maps id/title/designer/type/fragranticaUrl onto id/name/brand/concentration/fragranticaUrl', async () => {
    _resetClient(
      makeMockClient([
        {
          id: 'altha-r__parfums-de-marly__edp',
          title: 'Althaïr',
          designer: 'Parfums de Marly',
          type: 'EDP',
          fragranticaUrl: 'https://www.fragrantica.com/perfume/Parfums-de-Marly/Althair-12345.html',
          description: 'A gift from my wife',
          rating: 5,
          date: '01-06-2023',
          ownership: 'Full bottle',
          longevity: 6,
          projection: 3,
          seasons: ['Fall', 'Winter'],
          applicationSpots: ['Wrists', 'Neck'],
        },
      ]),
    );
    const perfumes = await loadPerfumes();
    assert.deepEqual(perfumes, [
      {
        id: 'altha-r__parfums-de-marly__edp',
        name: 'Althaïr',
        brand: 'Parfums de Marly',
        concentration: 'EDP',
        fragranticaUrl: 'https://www.fragrantica.com/perfume/Parfums-de-Marly/Althair-12345.html',
        description: 'A gift from my wife',
        rating: 5,
        dateAdded: '01-06-2023',
        ownership: 'Full bottle',
        personalLongevity: 6,
        personalProjection: 3,
        personalSeasons: ['Fall', 'Winter'],
        applicationSpots: ['Wrists', 'Neck'],
      },
    ]);
  });

  it('omits fragranticaUrl when the source item has none', async () => {
    _resetClient(
      makeMockClient([{ id: 'x__y__edt', title: 'X', designer: 'Y', type: 'EDT' }]),
    );
    const [p] = await loadPerfumes();
    assert.equal(p.fragranticaUrl, undefined);
  });

  it('omits a wrong-typed optional field without dropping the item', async () => {
    _resetClient(
      makeMockClient([
        {
          id: 'x__y__edt',
          title: 'X',
          designer: 'Y',
          type: 'EDT',
          rating: 'five',
          longevity: 'long',
          seasons: 'Fall',
        },
      ]),
    );
    const perfumes = await loadPerfumes();
    assert.equal(perfumes.length, 1);
    assert.equal(perfumes[0].rating, undefined);
    assert.equal(perfumes[0].personalLongevity, undefined);
    assert.equal(perfumes[0].personalSeasons, undefined);
  });

  it('omits all 8 optional fields when none are present on the source item', async () => {
    _resetClient(
      makeMockClient([{ id: 'x__y__edt', title: 'X', designer: 'Y', type: 'EDT' }]),
    );
    const [p] = await loadPerfumes();
    for (const key of [
      'description', 'rating', 'dateAdded', 'ownership',
      'personalLongevity', 'personalProjection', 'personalSeasons', 'applicationSpots',
    ] as const) {
      assert.equal(p[key], undefined);
    }
  });

  it('skips a malformed item (missing required field) rather than throwing', async () => {
    _resetClient(
      makeMockClient([
        { id: 'ok__b__edp', title: 'Ok', designer: 'B', type: 'EDP' },
        { id: 'broken', title: 'Missing designer/type' },
      ]),
    );
    const perfumes = await loadPerfumes();
    assert.equal(perfumes.length, 1);
    assert.equal(perfumes[0].id, 'ok__b__edp');
  });
});

console.log('  ✓ perfumes loadPerfumes reads + maps live PerfumeRatings items');
