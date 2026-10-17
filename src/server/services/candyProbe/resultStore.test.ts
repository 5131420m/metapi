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
      score: 3,
      total: 3,
      endpoint: 'messages',
      actualModel: 'claude-sonnet-4-5-20250929',
      latencyMs: 1200,
      checkedAt: new Date().toISOString(),
      reason: null,
      parseMode: 'numbered',
      questions: [
        { id: 'compare-decimals', prompt: 'Q', expected: '9.9', answer: '9.9', correct: true },
      ],
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
    expect(snapshot).not.toHaveProperty('questions');
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

  it('returns the full result (with per-question detail) on demand', () => {
    store.recordCandyProbeResult(buildResult());
    expect(store.getCandyProbeResultForChannel(7)?.questions).toHaveLength(1);
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
      score: 3,
    });
    expect(restored?.questions).toHaveLength(1);
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
});
