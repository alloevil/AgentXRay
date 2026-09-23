const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');

let api;
before(async () => {
  const source = readFileSync(path.join(__dirname, '../frontend/src/views/sessions/diagnostic-reviews.ts'), 'utf8');
  api = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`);
});
const stamp = '2026-09-23T12:00:00.000Z';
const identity = (index = 1) => ({
  storageKey: `axr-diagnostic-review-v1:${String(index).padStart(64, '0')}`,
  fingerprint: String(index + 10).padStart(64, '0'),
});
function storage() {
  const values = new Map();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}
function seed(store, current = identity(), note = 'Synthetic human evidence', status = 'expected') {
  api.saveReview(store, current, status, note, stamp);
}
function bundle() {
  const source = storage();
  seed(source);
  return api.createReviewTransfer(source, [identity()], stamp);
}
const parse = (value) => api.parseReviewTransfer(JSON.stringify(value));

test('export whitelist never includes logs, unrelated storage, stale or missing reviews', () => {
  const source = storage();
  seed(source);
  const stored = JSON.parse(source.getItem(identity().storageKey));
  stored.rawLog = 'PRIVATE_LOG';
  source.setItem(identity().storageKey, JSON.stringify(stored));
  seed(source, identity(2));
  source.setItem('settings', 'PRIVATE_SETTINGS');
  const current = [identity(), { ...identity(2), fingerprint: 'f'.repeat(64) }, identity(3)];
  const exported = api.createReviewTransfer(source, current, stamp);
  assert.equal(exported.records.length, 1);
  assert.deepEqual(Object.keys(exported).sort(), ['exportedAt', 'format', 'records', 'version']);
  assert.deepEqual(Object.keys(exported.records[0]).sort(), ['record', 'storageKey']);
  assert.deepEqual(Object.keys(exported.records[0].record).sort(), [
    'fingerprint',
    'note',
    'reviewedAt',
    'status',
    'version',
  ]);
  assert.doesNotMatch(JSON.stringify(exported), /PRIVATE/);
  assert.deepEqual(parse(exported), exported);
});

test('preview reads but never writes; matching empty slots import unchanged human notes', () => {
  const file = bundle();
  const target = storage();
  const rows = api.previewReviewTransfer(target, file, [identity()]);
  assert.deepEqual(
    rows.map((row) => row.decision),
    ['import']
  );
  assert.equal(target.values.size, 0);
  const result = api.importReviewTransfer(target, file, [identity()]);
  assert.deepEqual(result, { imported: 1, skipped: 0, failed: 0 });
  assert.deepEqual(JSON.parse(target.getItem(identity().storageKey)), file.records[0].record);
});

test('handwritten HTML remains literal text, not stripped or executed', () => {
  const source = storage();
  seed(source, identity(), '<script>synthetic()</script> & review');
  const file = parse(api.createReviewTransfer(source, [identity()], stamp));
  const target = storage();
  api.importReviewTransfer(target, file, [identity()]);
  assert.equal(api.readReview(target, identity()).record.note, '<script>synthetic()</script> & review');
});

test('current scope mismatch and changed fingerprints are skipped', () => {
  const file = bundle();
  const target = storage();
  assert.equal(api.previewReviewTransfer(target, file, [identity(2)])[0].decision, 'unmatched');
  assert.equal(
    api.previewReviewTransfer(target, file, [{ ...identity(), fingerprint: 'f'.repeat(64) }])[0].decision,
    'stale'
  );
  assert.deepEqual(api.importReviewTransfer(target, file, []), { imported: 0, skipped: 1, failed: 0 });
  assert.equal(target.values.size, 0);
});

test('identical records are skipped without overwriting timestamps or notes', () => {
  const target = storage();
  seed(target);
  assert.equal(api.previewReviewTransfer(target, bundle(), [identity()])[0].decision, 'duplicate');
  assert.deepEqual(api.importReviewTransfer(target, bundle(), [identity()]), { imported: 0, skipped: 1, failed: 0 });
});

test('different, stale and corrupt existing slots are conflicts and never overwritten', () => {
  for (const raw of [
    '{broken',
    JSON.stringify({ version: 2 }),
    JSON.stringify({
      version: 1,
      fingerprint: identity().fingerprint,
      status: 'follow-up',
      note: 'Local wins',
      reviewedAt: stamp,
    }),
    JSON.stringify({
      version: 1,
      fingerprint: 'f'.repeat(64),
      status: 'expected',
      note: 'Old local',
      reviewedAt: stamp,
    }),
  ]) {
    const target = storage();
    target.setItem(identity().storageKey, raw);
    assert.equal(api.previewReviewTransfer(target, bundle(), [identity()])[0].decision, 'conflict');
    assert.deepEqual(api.importReviewTransfer(target, bundle(), [identity()]), { imported: 0, skipped: 1, failed: 0 });
    assert.equal(target.getItem(identity().storageKey), raw);
  }
});

test('local review added after preview is rechecked and preserved', () => {
  const target = storage();
  const file = bundle();
  assert.equal(api.previewReviewTransfer(target, file, [identity()])[0].decision, 'import');
  seed(target, identity(), 'Saved in another tab', 'follow-up');
  assert.deepEqual(api.importReviewTransfer(target, file, [identity()]), { imported: 0, skipped: 1, failed: 0 });
  assert.equal(api.readReview(target, identity()).record.note, 'Saved in another tab');
});

test('evidence changed after preview is rechecked before writes', () => {
  const target = storage();
  const file = bundle();
  api.previewReviewTransfer(target, file, [identity()]);
  assert.deepEqual(api.importReviewTransfer(target, file, [{ ...identity(), fingerprint: 'e'.repeat(64) }]), {
    imported: 0,
    skipped: 1,
    failed: 0,
  });
  assert.equal(target.values.size, 0);
});

test('malformed JSON, unknown format/version and unknown fields are rejected', () => {
  assert.throws(() => api.parseReviewTransfer('{broken'));
  const original = bundle();
  for (const change of [
    null,
    [],
    {},
    { ...original, version: 2 },
    { ...original, format: 'other' },
    { ...original, logs: [] },
    { ...original, exportedAt: 'invalid' },
    { ...original, records: [{ ...original.records[0], path: '/private' }] },
    { ...original, records: [{ ...original.records[0], record: { ...original.records[0].record, rawLog: 'hidden' } }] },
  ]) {
    assert.throws(() => parse(change));
  }
});

test('arbitrary storage keys, bad fingerprints/status/notes/times are rejected', () => {
  const original = bundle();
  for (const key of ['settings', '__proto__', `${api.REVIEW_PREFIX}not-a-hash`]) {
    assert.throws(() => parse({ ...original, records: [{ ...original.records[0], storageKey: key }] }));
  }
  for (const changes of [
    { fingerprint: 'bad' },
    { status: 'success' },
    { note: '' },
    { note: ' ' },
    { note: 'x'.repeat(1001) },
    { reviewedAt: 'bad' },
    { version: 2 },
  ]) {
    assert.throws(() =>
      parse({
        ...original,
        records: [{ ...original.records[0], record: { ...original.records[0].record, ...changes } }],
      })
    );
  }
});

test('duplicate entries and over-limit files are rejected before any writes', () => {
  const original = bundle();
  assert.throws(() => parse({ ...original, records: [original.records[0], original.records[0]] }));
  assert.throws(() =>
    parse({
      ...original,
      records: Array.from({ length: 501 }, (_, index) => ({
        ...original.records[0],
        storageKey: identity(index).storageKey,
      })),
    })
  );
  assert.throws(() => api.parseReviewTransfer(' '.repeat(api.REVIEW_TRANSFER_MAX_BYTES + 1)));
  assert.throws(() => api.parseReviewTransfer('文'.repeat(Math.ceil(api.REVIEW_TRANSFER_MAX_BYTES / 3) + 1)));
  const target = storage();
  assert.throws(() =>
    api.importReviewTransfer(target, { ...original, records: [original.records[0], original.records[0]] }, [identity()])
  );
  assert.equal(target.values.size, 0);
});

test('export refuses unreadable current records instead of silently omitting them', () => {
  const broken = storage();
  broken.setItem(identity().storageKey, '{broken');
  assert.throws(() => api.createReviewTransfer(broken, [identity()], stamp));
  assert.throws(() =>
    api.createReviewTransfer(
      {
        getItem() {
          throw new Error('blocked');
        },
      },
      [identity()],
      stamp
    )
  );
});

test('import read denial is explicit and makes no writes', () => {
  let writes = 0;
  const blocked = {
    getItem() {
      throw new Error('blocked');
    },
    setItem() {
      writes++;
    },
  };
  assert.throws(() => api.previewReviewTransfer(blocked, bundle(), [identity()]));
  assert.throws(() => api.importReviewTransfer(blocked, bundle(), [identity()]));
  assert.equal(writes, 0);
});

test('partial write failure reports exact counts and preserves successful prior imports', () => {
  const source = storage();
  seed(source, identity());
  seed(source, identity(2));
  const file = api.createReviewTransfer(source, [identity(), identity(2)], stamp);
  const target = storage();
  const originalSet = target.setItem;
  target.setItem = (key, value) => {
    if (key === identity(2).storageKey) throw new Error('quota');
    originalSet(key, value);
  };
  assert.deepEqual(api.importReviewTransfer(target, file, [identity(), identity(2)]), {
    imported: 1,
    skipped: 0,
    failed: 1,
  });
  assert.equal(target.values.size, 1);
  assert.equal(api.reviewState(api.readReview(target, identity())), 'expected');
});

test('empty export and import are valid no-ops', () => {
  const target = storage();
  const file = api.createReviewTransfer(target, [identity()], stamp);
  assert.deepEqual(file.records, []);
  assert.deepEqual(api.importReviewTransfer(target, parse(file), [identity()]), { imported: 0, skipped: 0, failed: 0 });
});

test('500 records roundtrip within the byte limit; large Unicode exports are refused', () => {
  const source = storage();
  const identities = Array.from({ length: 500 }, (_, index) => identity(index));
  for (const current of identities) seed(source, current, 'Synthetic note '.repeat(20));
  const file = api.createReviewTransfer(source, identities, stamp);
  const text = `${JSON.stringify(file, null, 2)}\n`;
  assert.ok(Buffer.byteLength(text) <= api.REVIEW_TRANSFER_MAX_BYTES);
  assert.equal(api.parseReviewTransfer(text).records.length, 500);
  for (const current of identities) seed(source, current, '文'.repeat(1000));
  assert.throws(() => api.createReviewTransfer(source, identities, stamp));
});

test('a malformed final entry prevents importing earlier valid entries', () => {
  const file = bundle();
  file.records.push({ storageKey: identity(2).storageKey, record: { ...file.records[0].record, note: '' } });
  const target = storage();
  assert.throws(() => api.importReviewTransfer(target, file, [identity(), identity(2)]));
  assert.equal(target.values.size, 0);
});
