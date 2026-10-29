import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { eq } from 'drizzle-orm';
import type { IdentityProbeResult } from '../../../shared/modelIdentityProbe.js';

type DbModule = typeof import('../../db/index.js');
type StoreModule = typeof import('./resultStore.js');

function makeResult(overrides: Partial<IdentityProbeResult> = {}): IdentityProbeResult {
  return {
    channelId: 7,
    routeId: 1,
    model: 'claude-opus-4-6',
    verdict: 'model_match',
    reason: null,
    decision: 'scored',
    prediction: { model: 'claude-opus-4.6', displayName: 'claude-opus-4.6', family: 'claude', familyName: 'Claude', probability: 0.7 },
    candidates: [{ model: 'claude-opus-4.6', displayName: 'claude-opus-4.6', family: 'claude', familyName: 'Claude', probability: 0.7 }],
    probability: 0.7,
    probabilityStatus: 'reference_calibrated',
    claimedModel: 'claude-opus-4.6',
    claimedFamily: 'claude',
    claimedFamilyName: 'Claude',
    claimedRank: 1,
    claimedProbability: 0.7,
    modelLike: true,
    usedOutputs: 3,
    samples: [
      { index: 1, state: 'complete', count: 300, expectedCount: 300, accepted: true, responseModel: null, latencyMs: 10, error: null },
    ],
    requestFormat: 'claude',
    endpoint: 'messages',
    actualModel: null,
    latencyMs: 100,
    checkedAt: new Date().toISOString(),
    config: { model: 'claude-opus-4-6', accountId: 3, tokenId: 4, bankBuiltAt: 'bank-1' },
    trigger: 'manual',
    ...overrides,
  };
}

describe('identity probe result store', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let store: StoreModule;
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-identity-store-'));
    process.env.DATA_DIR = dataDir;
    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    db = dbModule.db;
    schema = dbModule.schema;
    store = await import('./resultStore.js');
  });

  beforeEach(async () => {
    store.resetIdentityProbeStoreForTests();
    await db.delete(schema.settings).run();
  });

  afterAll(() => {
    store.resetIdentityProbeStoreForTests();
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows file lock */ }
  });

  it('persists and hydrates a result', async () => {
    store.recordIdentityProbeResult(makeResult());
    await store.flushIdentityProbeResultsPersistence();
    store.resetIdentityProbeStoreForTests();
    expect(store.getIdentityProbeResultForChannel(7)).toBeNull();

    await store.hydrateIdentityProbeResultsFromSettings();
    const restored = store.getIdentityProbeResultForChannel(7);
    expect(restored?.verdict).toBe('model_match');
    expect(restored?.config.bankBuiltAt).toBe('bank-1');
    expect(restored?.samples).toHaveLength(1);
  });

  it('drops a snapshot whose channel config changed', () => {
    store.recordIdentityProbeResult(makeResult());
    const same = { model: 'claude-opus-4-6', accountId: 3, tokenId: 4, bankBuiltAt: 'bank-1' };
    expect(store.getIdentityProbeSnapshots([7], { 7: same })['7']).toBeDefined();
    expect(store.getIdentityProbeSnapshots([7], { 7: { ...same, model: 'gpt-5.4' } })['7']).toBeUndefined();
    expect(store.getIdentityProbeSnapshots([7], { 7: { ...same, tokenId: 9 } })['7']).toBeUndefined();
  });

  it('drops a snapshot scored against another reference bank, but only once the bank is known', () => {
    store.recordIdentityProbeResult(makeResult());
    const current = { model: 'claude-opus-4-6', accountId: 3, tokenId: 4 };
    expect(store.getIdentityProbeSnapshots([7], { 7: { ...current, bankBuiltAt: 'bank-2' } })['7']).toBeUndefined();
    // Before this process has loaded a bank, the list must not hide every verdict.
    expect(store.getIdentityProbeSnapshots([7], { 7: { ...current, bankBuiltAt: null } })['7']).toBeDefined();
  });

  it('snapshots omit samples and candidates, and expire after 24h', () => {
    const checkedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    store.recordIdentityProbeResult(makeResult({ checkedAt }));
    const snapshot = store.getIdentityProbeSnapshots([7])['7']!;
    expect(snapshot.fresh).toBe(false);
    expect('samples' in snapshot).toBe(false);
    expect('candidates' in snapshot).toBe(false);
  });

  it('caps lists and text on write', () => {
    const many = Array.from({ length: 9 }, (_, index) => ({
      model: `m${index}`, displayName: `m${index}`, family: 'gpt', familyName: 'GPT', probability: 0.1,
    }));
    const recorded = store.recordIdentityProbeResult(makeResult({ candidates: many, reason: 'x'.repeat(2000) }));
    expect(recorded.candidates).toHaveLength(5);
    expect(recorded.reason?.length).toBe(300);
  });

  it('rejects malformed rows on hydrate', async () => {
    await db.insert(schema.settings).values({
      key: store.IDENTITY_PROBE_SETTING_KEY,
      value: JSON.stringify({
        1: { channelId: 1, verdict: 'definitely-not-a-verdict', checkedAt: new Date().toISOString() },
        2: makeResult({ channelId: 2 }),
      }),
    }).run();
    await store.hydrateIdentityProbeResultsFromSettings();
    expect(store.getIdentityProbeResultForChannel(1)).toBeNull();
    expect(store.getIdentityProbeResultForChannel(2)?.verdict).toBe('model_match');
  });

  it('reads a pre-grading `match` row as family_match, never model_match', async () => {
    const legacy = { ...makeResult({ channelId: 3 }), verdict: 'match' } as unknown as Record<string, unknown>;
    delete legacy.claimedProbability;
    await db.insert(schema.settings).values({
      key: store.IDENTITY_PROBE_SETTING_KEY,
      value: JSON.stringify({ 3: legacy }),
    }).run();
    await store.hydrateIdentityProbeResultsFromSettings();
    const restored = store.getIdentityProbeResultForChannel(3);
    expect(restored?.verdict).toBe('family_match');
    expect(restored?.claimedProbability).toBeNull();
  });

  it('reads rows stored before the identity source existed as sdk', async () => {
    const legacy = { ...makeResult({ channelId: 4 }) } as unknown as Record<string, unknown>;
    delete legacy.identitySource;
    delete legacy.identityUserAgent;
    await db.insert(schema.settings).values({
      key: store.IDENTITY_PROBE_SETTING_KEY,
      value: JSON.stringify({
        4: legacy,
        5: { ...makeResult({ channelId: 5 }), identitySource: 'observed', identityUserAgent: 'claude-cli/2.1.151' },
      }),
    }).run();
    await store.hydrateIdentityProbeResultsFromSettings();
    expect(store.getIdentityProbeResultForChannel(4)?.identitySource).toBe('sdk');
    expect(store.getIdentityProbeResultForChannel(4)?.identityUserAgent).toBeNull();
    expect(store.getIdentityProbeResultForChannel(5)?.identitySource).toBe('observed');
    expect(store.getIdentityProbeResultForChannel(5)?.identityUserAgent).toBe('claude-cli/2.1.151');
  });

  it('drops a run that finished after a reset', () => {
    const generation = store.getIdentityProbeStoreGeneration();
    store.resetIdentityProbeStoreForTests();
    expect(store.recordIdentityProbeResultIfCurrent(makeResult(), generation)).toBe(false);
    expect(store.getIdentityProbeResultForChannel(7)).toBeNull();
  });

  it('discard clears memory and the persisted row', async () => {
    store.recordIdentityProbeResult(makeResult());
    await store.flushIdentityProbeResultsPersistence();
    await store.discardIdentityProbeResults();
    expect(store.getIdentityProbeResultForChannel(7)).toBeNull();
    const row = await db.select().from(schema.settings)
      .where(eq(schema.settings.key, store.IDENTITY_PROBE_SETTING_KEY)).get();
    expect(JSON.parse(String(row?.value ?? '{}'))).toEqual({});
  });
});
