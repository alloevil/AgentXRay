const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');

let reviews;
before(async () => {
  const source = readFileSync(path.join(__dirname, '../frontend/src/views/sessions/diagnostic-reviews.ts'), 'utf8');
  reviews = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`);
});

const clone = (value) => JSON.parse(JSON.stringify(value));
function event() {
  return {
    id: 'failure-event-2',
    toolName: 'edit',
    userTurn: 1,
    argumentsText: '{"path":"/synthetic/private.ts","old":"a","new":"b"}',
    failures: [
      {
        index: 2,
        toolName: 'edit',
        reason: 'no-success',
        evidence: 'short preview',
        message: {
          id: 'first',
          toolCallId: 'call-first',
          timestamp: '2026-09-23T08:00:00Z',
          isError: true,
          content: [{ type: 'text', text: 'Synthetic full output '.repeat(50) }],
          details: { exitCode: 1 },
        },
      },
    ],
    spanMs: 0,
  };
}

function storage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    values,
  };
}

test('review identities are deterministic and contain no raw scope, parameters or output', async () => {
  const current = event();
  const first = await reviews.createReviewIdentity('omp:synthetic-session:child', current);
  assert.deepEqual(first, await reviews.createReviewIdentity('omp:synthetic-session:child', clone(current)));
  assert.match(first.storageKey, /^axr-diagnostic-review-v1:[a-f0-9]{64}$/);
  assert.match(first.fingerprint, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(first), /private|Synthetic|synthetic-session|child/);
});

test('platform, parent session, child and event identities cannot share reviews', async () => {
  const identities = await Promise.all(
    ['omp:one:', 'omp:two:', 'omp:one:child', 'codex:one:'].map((scope) => reviews.createReviewIdentity(scope, event()))
  );
  const other = event();
  other.failures[0].message.id = 'different';
  identities.push(await reviews.createReviewIdentity('omp:one:', other));
  assert.equal(new Set(identities.map((identity) => identity.storageKey)).size, 5);
});

test('object key ordering does not invalidate a review', async () => {
  const original = event();
  const reordered = clone(original);
  reordered.argumentsText = '{"new":"b","old":"a","path":"/synthetic/private.ts"}';
  reordered.failures[0].message = Object.fromEntries(Object.entries(reordered.failures[0].message).reverse());
  assert.deepEqual(
    await reviews.createReviewIdentity('scope', original),
    await reviews.createReviewIdentity('scope', reordered)
  );
});

test('adding failure evidence preserves event identity but invalidates reviewed fingerprint', async () => {
  const original = event();
  const appended = clone(original);
  appended.failures.push({
    ...clone(original.failures[0]),
    index: 4,
    message: { ...clone(original.failures[0].message), id: 'second' },
  });
  const before = await reviews.createReviewIdentity('scope', original);
  const after = await reviews.createReviewIdentity('scope', appended);
  assert.equal(before.storageKey, after.storageKey);
  assert.notEqual(before.fingerprint, after.fingerprint);
  const store = storage();
  reviews.saveReview(store, before, 'expected', 'Synthetic expected probe', '2026-09-23T09:00:00Z');
  const entry = reviews.readReview(store, after);
  assert.equal(entry.stale, true);
  assert.equal(reviews.reviewState(entry), 'unreviewed');
  assert.equal(entry.record.note, 'Synthetic expected probe');
});

test('full output beyond the preview, structured metadata and reasons invalidate review', async () => {
  const original = event();
  const before = await reviews.createReviewIdentity('scope', original);
  const variants = [clone(original), clone(original), clone(original)];
  variants[0].failures[0].message.content[0].text += 'changed after 500 characters';
  variants[1].failures[0].message.details.exitCode = 2;
  variants[2].failures[0].reason = 'unconfirmed-retry';
  for (const changed of variants) {
    const after = await reviews.createReviewIdentity('scope', changed);
    assert.equal(before.storageKey, after.storageKey);
    assert.notEqual(before.fingerprint, after.fingerprint);
  }
});

test('parameter, turn and first occurrence changes cannot reuse a review', async () => {
  const original = event();
  const before = await reviews.createReviewIdentity('scope', original);
  const variants = [clone(original), clone(original), clone(original)];
  variants[0].argumentsText = '{"path":"/synthetic/other.ts"}';
  variants[1].userTurn++;
  variants[2].failures[0].index++;
  for (const changed of variants) {
    assert.notEqual(before.storageKey, (await reviews.createReviewIdentity('scope', changed)).storageKey);
  }
});

for (const status of ['follow-up', 'expected', 'verified-elsewhere']) {
  test(`roundtrip ${status} preserves explicit human evidence, not raw logs`, async () => {
    const store = storage();
    const identity = await reviews.createReviewIdentity('scope', event());
    reviews.saveReview(store, identity, status, '  Synthetic check evidence  ', '2026-09-23T09:00:00Z');
    const saved = reviews.readReview(store, identity);
    assert.equal(saved.stale, false);
    assert.equal(saved.record.note, 'Synthetic check evidence');
    assert.equal(reviews.reviewState(saved), status);
    assert.equal(saved.record.reviewedAt, '2026-09-23T09:00:00Z');
    assert.doesNotMatch(store.getItem(identity.storageKey), /private\.ts|full output/);
  });
}

test('notes are required and bounded; status/time validation is not just UI validation', async () => {
  const store = storage();
  const identity = await reviews.createReviewIdentity('scope', event());
  for (const note of ['', '  ', 'x'.repeat(1001)]) {
    assert.throws(() => reviews.saveReview(store, identity, 'expected', note, '2026-09-23T09:00:00Z'));
  }
  assert.throws(() => reviews.saveReview(store, identity, 'auto-success', 'note', '2026-09-23T09:00:00Z'));
  assert.throws(() => reviews.saveReview(store, identity, 'expected', 'note', 'not a date'));
  assert.equal(store.values.size, 0);
});

test('missing review is unreviewed; corrupt or future schema is rejected', async () => {
  const store = storage();
  const identity = await reviews.createReviewIdentity('scope', event());
  assert.equal(reviews.reviewState(reviews.readReview(store, identity)), 'unreviewed');
  for (const raw of ['broken', '{}', 'null', JSON.stringify({ version: 2 })]) {
    store.setItem(identity.storageKey, raw);
    assert.throws(() => reviews.readReview(store, identity));
  }
});

test('blocked read and failed write propagate instead of claiming persistence', async () => {
  const identity = await reviews.createReviewIdentity('scope', event());
  assert.throws(
    () =>
      reviews.readReview(
        {
          getItem() {
            throw new Error('blocked');
          },
        },
        identity
      ),
    /blocked/
  );
  assert.throws(
    () =>
      reviews.saveReview(
        {
          setItem() {
            throw new Error('quota');
          },
        },
        identity,
        'expected',
        'Synthetic evidence',
        '2026-09-23T09:00:00Z'
      ),
    /quota/
  );
});

test('clearing one review leaves other events and unrelated settings intact', async () => {
  const store = storage();
  const first = await reviews.createReviewIdentity('scope', event());
  const other = await reviews.createReviewIdentity('other', event());
  store.setItem('settings', 'keep');
  reviews.saveReview(store, first, 'expected', 'Synthetic first', '2026-09-23T09:00:00Z');
  reviews.saveReview(store, other, 'follow-up', 'Synthetic second', '2026-09-23T09:00:00Z');
  reviews.clearReview(store, first);
  assert.equal(reviews.reviewState(reviews.readReview(store, first)), 'unreviewed');
  assert.equal(reviews.reviewState(reviews.readReview(store, other)), 'follow-up');
  assert.equal(store.getItem('settings'), 'keep');
});

test('saving a fresh note explicitly renews stale review', async () => {
  const store = storage();
  const original = event();
  const before = await reviews.createReviewIdentity('scope', original);
  reviews.saveReview(store, before, 'expected', 'Old synthetic evidence', '2026-09-23T09:00:00Z');
  original.failures[0].message.content[0].text += 'new output';
  const after = await reviews.createReviewIdentity('scope', original);
  assert.equal(reviews.reviewState(reviews.readReview(store, after)), 'unreviewed');
  reviews.saveReview(store, after, 'follow-up', 'New synthetic evidence', '2026-09-23T10:00:00Z');
  assert.equal(reviews.reviewState(reviews.readReview(store, after)), 'follow-up');
});
