import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { eq } from 'drizzle-orm';

type DbModule = typeof import('../../db/index.js');
type StoreModule = typeof import('./resultStore.js');

const HOUR_MS = 60 * 60 * 1000;

describe('candy probe result store', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let store: StoreModule;
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-candy-store-'));
    process.env.DATA_DIR = dataDir;
    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    db = dbModule.db;
    schema = dbModule.schema;
    store = await import('./resultStore.js');
  });

  beforeEach(async () => {
    store.resetCandyProbeStoreForTests();
    await db.delete(schema.settings).run();
  });

  afterAll(() => {
    store.resetCandyProbeStoreForTests();
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // Windows keeps the SQLite handle open.
    }
    delete process.env.DATA_DIR;
  });

  function buildResult(overrides: Partial<StoreModule['CandyProbeResult']> = {}): StoreModule['CandyProbeResult'] {
    return {
      channelId: 7,
      routeId: 3,
      model: 'claude-sonnet-4-5',
      fingerprint: 'claude_code',
      verdict: 'pass',
      score: 1,
      total: 1,
      endpoint: 'messages',
      actualModel: 'claude-sonnet-4-5-20250929',
      latencyMs: 1200,
      checkedAt: new Date().toISOString(),
      reason: null,
      question: { id: 'candy-bag-reference', prompt: 'Q', expected: '21' },
      samples: [
        { index: 1, answer: '21', correct: true, note: null },
      ],
      validSampleCount: 1,
      config: { model: 'claude-sonnet-4-5', accountId: 11, tokenId: 22 },
      ...overrides,
    };
  }

  it('exposes a fresh snapshot with the detail stripped out', () => {
    store.recordCandyProbeResult(buildResult());
    const snapshot = store.getCandyProbeSnapshots([7])['7'];

    expect(snapshot).toBeTruthy();
    expect(snapshot?.fresh).toBe(true);
    expect(snapshot?.verdict).toBe('pass');
    // The list stays lean: per-sample detail is fetched on demand.
    expect(snapshot).not.toHaveProperty('samples');
    expect(snapshot?.question.id).toBe('candy-bag-reference');
    expect(snapshot?.validSampleCount).toBe(1);
    expect(Date.parse(snapshot?.expiresAt as string)).toBeGreaterThan(Date.now());
  });

  it('marks a verdict older than the TTL as stale without deleting it', () => {
    store.recordCandyProbeResult(buildResult({
      checkedAt: new Date(Date.now() - (HOUR_MS + 60_000)).toISOString(),
    }));

    const snapshot = store.getCandyProbeSnapshots([7])['7'];
    expect(snapshot?.fresh).toBe(false);
    expect(store.getCandyProbeResultForChannel(7)?.verdict).toBe('pass');
  });

  it('returns the full result (with the single answer detail) on demand', () => {
    store.recordCandyProbeResult(buildResult());
    expect(store.getCandyProbeResultForChannel(7)?.samples).toHaveLength(1);
    expect(store.getCandyProbeResultForChannel(999)).toBeNull();
  });

  it('survives a restart through the settings blob', async () => {
    store.recordCandyProbeResult(buildResult());
    await store.flushCandyProbeResultsPersistence();

    store.resetCandyProbeStoreForTests();
    expect(store.getCandyProbeResultForChannel(7)).toBeNull();

    await store.hydrateCandyProbeResultsFromSettings();
    const restored = store.getCandyProbeResultForChannel(7);
    expect(restored).toMatchObject({
      channelId: 7,
      verdict: 'pass',
      fingerprint: 'claude_code',
      score: 1,
    });
    // The question and the single answer's detail survive the round trip: a restored
    // verdict that lost them would show a badge with nothing behind it.
    expect(restored?.samples).toHaveLength(1);
    expect(restored?.validSampleCount).toBe(1);
    expect(restored?.question).toEqual({ id: 'candy-bag-reference', prompt: 'Q', expected: '21' });
  });

  it('discard clears both the v2 blob and the retired v1 blob', async () => {
    store.recordCandyProbeResult(buildResult());
    await store.flushCandyProbeResultsPersistence();
    // A v1 blob from an older build: discard must clear it too, or the next restart of
    // that older build would resurrect multi-sample verdicts this build can no longer read.
    await db.insert(schema.settings).values({
      key: store.CANDY_PROBE_SETTING_KEY_V1,
      value: JSON.stringify({ 7: buildResult({ verdict: 'fail' }) }),
    }).onConflictDoUpdate({
      target: schema.settings.key,
      set: { value: JSON.stringify({ 7: buildResult({ verdict: 'fail' }) }) },
    });

    await store.discardCandyProbeResults();

    expect(store.getCandyProbeResultForChannel(7)).toBeNull();
    // Both blobs are emptied rather than deleted (single write path), so the keys stay
    // but carry no verdicts.
    const rows = await db.select().from(schema.settings).all();
    const byKey = new Map(rows.map((row) => [row.key, row.value]));
    expect(byKey.get(store.CANDY_PROBE_SETTING_KEY)).toBe('{}');
    expect(byKey.get(store.CANDY_PROBE_SETTING_KEY_V1)).toBe('{}');
  });

  it('ignores malformed and expired entries when hydrating', async () => {
    const stored = {
      7: { channelId: 7, verdict: 'not-a-verdict' },
      8: buildResult({ channelId: 8, checkedAt: new Date(Date.now() - 8 * 24 * HOUR_MS).toISOString() }),
      9: buildResult({ channelId: 9 }),
    };
    await db.insert(schema.settings).values({
      key: store.CANDY_PROBE_SETTING_KEY,
      value: JSON.stringify(stored),
    }).run();

    await store.hydrateCandyProbeResultsFromSettings();

    expect(store.getCandyProbeResultForChannel(7)).toBeNull();
    expect(store.getCandyProbeResultForChannel(8)).toBeNull();
    expect(store.getCandyProbeResultForChannel(9)?.verdict).toBe('pass');
  });

  it('tolerates a corrupt blob instead of throwing', async () => {
    await db.insert(schema.settings).values({
      key: store.CANDY_PROBE_SETTING_KEY,
      value: '{not json',
    }).run();

    await expect(store.hydrateCandyProbeResultsFromSettings()).resolves.toBeUndefined();
    expect(store.getCandyProbeResultForChannel(7)).toBeNull();
  });

  it('writes the store under one settings key', async () => {
    store.recordCandyProbeResult(buildResult());
    await store.flushCandyProbeResultsPersistence();

    const row = await db.select().from(schema.settings)
      .where(eq(schema.settings.key, store.CANDY_PROBE_SETTING_KEY))
      .get();
    expect(row).toBeTruthy();
    expect(JSON.parse(row?.value as string)['7'].verdict).toBe('pass');
  });

  it('persists a verdict that landed while a flush was already running', async () => {
    store.recordCandyProbeResult(buildResult({ verdict: 'pass' }));
    const firstFlush = store.flushCandyProbeResultsPersistence();
    // The newer verdict arrives mid-flush and asks for its own flush: that second call used
    // to just await the first one and return, leaving the newest state on disk only until
    // something else happened to trigger a write.
    store.recordCandyProbeResult(buildResult({ verdict: 'fail', score: 1 }));
    const secondFlush = store.flushCandyProbeResultsPersistence();
    await Promise.all([firstFlush, secondFlush]);

    const row = await db.select().from(schema.settings)
      .where(eq(schema.settings.key, store.CANDY_PROBE_SETTING_KEY))
      .get();
    expect(JSON.parse(row?.value as string)['7']).toMatchObject({ verdict: 'fail', score: 1 });
  });

  it('drops a snapshot whose channel configuration changed underneath it', () => {
    store.recordCandyProbeResult(buildResult());
    const current = { 7: { model: 'claude-sonnet-4-5', accountId: 11, tokenId: 22 } };

    expect(store.getCandyProbeSnapshots([7], current)['7']).toBeTruthy();
    // Same channel id, different upstream: swap the source model...
    expect(store.getCandyProbeSnapshots([7], {
      7: { model: 'gpt-5.6-sol', accountId: 11, tokenId: 22 },
    })['7']).toBeUndefined();
    // ...or the credential behind it.
    expect(store.getCandyProbeSnapshots([7], {
      7: { model: 'claude-sonnet-4-5', accountId: 11, tokenId: 99 },
    })['7']).toBeUndefined();
    expect(store.getCandyProbeSnapshots([7], {
      7: { model: 'claude-sonnet-4-5', accountId: 12, tokenId: 22 },
    })['7']).toBeUndefined();
  });

  it('keeps a verdict whose stored row predates the fingerprint', async () => {
    // Verdicts persisted before the config fingerprint existed have none; they must not
    // crash hydration, and they simply do not match a channel when one is supplied.
    await db.insert(schema.settings).values({
      key: store.CANDY_PROBE_SETTING_KEY,
      value: JSON.stringify({ 7: { ...buildResult(), config: undefined } }),
    }).run();
    await store.hydrateCandyProbeResultsFromSettings();

    expect(store.getCandyProbeResultForChannel(7)?.verdict).toBe('pass');
    expect(store.getCandyProbeSnapshots([7])['7']).toBeTruthy();
    expect(store.getCandyProbeSnapshots([7], {
      7: { model: 'claude-sonnet-4-5', accountId: 11, tokenId: 22 },
    })['7']).toBeUndefined();
  });

  it('clears everything on reset, so a replaced database cannot inherit verdicts', async () => {
    store.recordCandyProbeResult(buildResult());
    await store.flushCandyProbeResultsPersistence();
    expect(store.getCandyProbeResultForChannel(7)).toBeTruthy();

    store.resetCandyProbeStore();

    expect(store.getCandyProbeResultForChannel(7)).toBeNull();
    await store.flushCandyProbeResultsPersistence();
    const row = await db.select().from(schema.settings)
      .where(eq(schema.settings.key, store.CANDY_PROBE_SETTING_KEY))
      .get();
    expect(JSON.parse(row?.value as string)).toEqual({});
  });

  it('drops a verdict whose probe started before a reset', async () => {
    // A probe in flight across a factory reset (or a backup import) measured a channel of the
    // database that is being replaced. Ids restart from 1 after such a reset, so the stale
    // verdict can even match a brand-new channel's config fingerprint — it must not be kept.
    const generation = store.getCandyProbeStoreGeneration();

    store.resetCandyProbeStore();

    expect(store.getCandyProbeStoreGeneration()).not.toBe(generation);
    expect(store.recordCandyProbeResultIfCurrent(buildResult(), generation)).toBe(false);
    expect(store.getCandyProbeResultForChannel(7)).toBeNull();

    // The current generation still records normally.
    const current = store.getCandyProbeStoreGeneration();
    expect(store.recordCandyProbeResultIfCurrent(buildResult(), current)).toBe(true);
    expect(store.getCandyProbeResultForChannel(7)).toBeTruthy();
  });

  it('stops a persist pass from looping across a reset', async () => {
    // Ordering at the call sites (await flush, THEN reset) is what keeps an already-dispatched
    // write from landing after a reset; this covers the other half: a pass that started
    // before the reset must not loop back and pick up post-reset writes, which would publish
    // the new generation's verdicts under the old pass.
    store.recordCandyProbeResult(buildResult({ channelId: 7 }));
    const flushing = store.flushCandyProbeResultsPersistence();
    store.resetCandyProbeStore();
    store.recordCandyProbeResult(buildResult({ channelId: 8, verdict: 'pass' }));
    await flushing;

    const afterFirstPass = await db.select().from(schema.settings)
      .where(eq(schema.settings.key, store.CANDY_PROBE_SETTING_KEY))
      .get();
    expect(JSON.parse((afterFirstPass?.value as string) ?? '{}')).not.toHaveProperty('8');

    // The next flush writes the post-reset state, as it should.
    await store.flushCandyProbeResultsPersistence();
    const afterSecondPass = await db.select().from(schema.settings)
      .where(eq(schema.settings.key, store.CANDY_PROBE_SETTING_KEY))
      .get();
    expect(JSON.parse(afterSecondPass?.value as string)).toHaveProperty('8');
  });
});
