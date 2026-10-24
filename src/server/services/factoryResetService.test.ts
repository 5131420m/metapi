import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

type DbModule = typeof import('../db/index.js');
type ConfigModule = typeof import('../config.js');
type ServiceModule = typeof import('./factoryResetService.js');

describe('factoryResetService', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let config: ConfigModule['config'];
  let performFactoryReset: ServiceModule['performFactoryReset'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-factory-reset-service-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const configModule = await import('../config.js');
    const serviceModule = await import('./factoryResetService.js');

    db = dbModule.db;
    schema = dbModule.schema;
    config = configModule.config;
    performFactoryReset = serviceModule.performFactoryReset;
  });

  beforeEach(async () => {
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.proxyLogs).run();
    await db.delete(schema.proxyVideoTasks).run();
    await db.delete(schema.checkinLogs).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.sites).run();
    await db.delete(schema.downstreamApiKeys).run();
    await db.delete(schema.events).run();
    await db.delete(schema.settings).run();

    config.authToken = 'external-reset-token';
    config.dbType = 'postgres';
    config.dbUrl = 'postgres://user:pass@127.0.0.1:5432/metapi';
    config.dbSsl = true;
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
  });

  it('clears current active data while preserving external runtime connectivity', async () => {
    await db.insert(schema.sites).values({
      name: 'External Runtime Site',
      url: 'https://external.example.com',
      platform: 'new-api',
    }).run();
    await db.insert(schema.settings).values([
      { key: 'auth_token', value: JSON.stringify('external-reset-token') },
      { key: 'db_type', value: JSON.stringify('postgres') },
      { key: 'db_url', value: JSON.stringify('postgres://user:pass@127.0.0.1:5432/metapi') },
      { key: 'db_ssl', value: JSON.stringify(true) },
    ]).run();

    const switchRuntimeDatabase = vi.fn(async () => undefined);
    const runSqliteMigrations = vi.fn(() => undefined);
    const ensureDefaultSitesSeeded = vi.fn(async () => ({
      seeded: 0,
      alreadyMarked: false,
      hadExistingSites: false,
    }));

    await performFactoryReset({
      switchRuntimeDatabase,
      runSqliteMigrations,
      ensureDefaultSitesSeeded,
    });

    expect(switchRuntimeDatabase).toHaveBeenCalledWith('postgres', 'postgres://user:pass@127.0.0.1:5432/metapi', true);
    expect(runSqliteMigrations).not.toHaveBeenCalled();
    expect(ensureDefaultSitesSeeded).toHaveBeenCalledTimes(1);
    expect(await db.select().from(schema.sites).all()).toHaveLength(0);
    expect(await db.select().from(schema.settings).all()).toEqual([
      { key: 'auth_token', value: JSON.stringify('external-reset-token') },
      { key: 'proxy_token', value: JSON.stringify('change-me-proxy-sk-token') },
      { key: 'system_proxy_url', value: JSON.stringify('') },
      { key: 'db_type', value: JSON.stringify('postgres') },
      { key: 'db_url', value: JSON.stringify('postgres://user:pass@127.0.0.1:5432/metapi') },
      { key: 'db_ssl', value: JSON.stringify(true) },
    ]);
  });

  it('stops the candy schedule and its freshness-TTL override when resetting to factory state', async () => {
    const schedulerModule = await import('./candyProbeScheduler.js');
    const storeModule = await import('./candyProbe/resultStore.js');
    const originalEnabled = config.candyProbeScheduleEnabled;
    const buildResult = (channelId: number) => ({
      channelId,
      routeId: null,
      model: 'gpt-5.6-sol',
      fingerprint: 'generic_openai',
      verdict: 'pass',
      score: 1,
      total: 1,
      endpoint: 'chat',
      actualModel: null,
      latencyMs: 1,
      checkedAt: new Date().toISOString(),
      reason: null,
      question: { id: 'candy-bag-reference', prompt: '', expected: '21' },
      samples: [{ index: 1, answer: '21', correct: true, note: null }],
      validSampleCount: 1,
      expectation: 'expected',
      config: { model: 'gpt-5.6-sol', accountId: null, tokenId: null },
      trigger: 'schedule',
      failStreak: 0,
    });

    try {
      config.candyProbeScheduleEnabled = true;
      schedulerModule.startCandyProbeScheduler(60_000);
      storeModule.recordCandyProbeResult(buildResult(424242));
      const scheduled = storeModule.getCandyProbeSnapshots([424242])[String(424242)]!;
      expect(Date.parse(scheduled.expiresAt) - Date.parse(scheduled.checkedAt)).toBeGreaterThan(60 * 60 * 1000);

      const switchRuntimeDatabase = vi.fn(async () => undefined);
      const runSqliteMigrations = vi.fn(() => undefined);
      const ensureDefaultSitesSeeded = vi.fn(async () => ({ seeded: 0, alreadyMarked: false, hadExistingSites: false }));
      await performFactoryReset({ switchRuntimeDatabase, runSqliteMigrations, ensureDefaultSitesSeeded });

      // The reset restored the baseline config (schedule off) — the running timer and the
      // TTL override must have followed, not survive until the next tick.
      expect(config.candyProbeScheduleEnabled).toBe(false);
      storeModule.recordCandyProbeResult(buildResult(424242));
      const afterReset = storeModule.getCandyProbeSnapshots([424242])[String(424242)]!;
      expect(Date.parse(afterReset.expiresAt) - Date.parse(afterReset.checkedAt)).toBe(60 * 60 * 1000);
    } finally {
      config.candyProbeScheduleEnabled = originalEnabled;
      schedulerModule.resetCandyProbeSchedulerForTests();
    }
  });

  it('restarts an env-enabled candy schedule after the reset instead of leaving it stopped', async () => {
    const schedulerModule = await import('./candyProbeScheduler.js');
    const storeModule = await import('./candyProbe/resultStore.js');
    const originalEnabled = config.candyProbeScheduleEnabled;
    const originalEnv = process.env.CANDY_PROBE_SCHEDULE_ENABLED;
    const buildResult = (channelId: number) => ({
      channelId,
      routeId: null,
      model: 'gpt-5.6-sol',
      fingerprint: 'generic_openai',
      verdict: 'pass',
      score: 1,
      total: 1,
      endpoint: 'chat',
      actualModel: null,
      latencyMs: 1,
      checkedAt: new Date().toISOString(),
      reason: null,
      question: { id: 'candy-bag-reference', prompt: '', expected: '21' },
      samples: [{ index: 1, answer: '21', correct: true, note: null }],
      validSampleCount: 1,
      expectation: 'expected',
      config: { model: 'gpt-5.6-sol', accountId: null, tokenId: null },
      trigger: 'schedule',
      failStreak: 0,
    });

    try {
      // The reset baseline comes from buildConfig(process.env): an env-enabled schedule
      // survives the reset as ENABLED config, so the timer must be running again rather
      // than stopped behind an enabled flag until the next restart. The freshness-TTL
      // override the scheduler installs is the observable.
      process.env.CANDY_PROBE_SCHEDULE_ENABLED = 'true';
      schedulerModule.startCandyProbeScheduler(60_000);

      const switchRuntimeDatabase = vi.fn(async () => undefined);
      const runSqliteMigrations = vi.fn(() => undefined);
      const ensureDefaultSitesSeeded = vi.fn(async () => ({ seeded: 0, alreadyMarked: false, hadExistingSites: false }));
      await performFactoryReset({ switchRuntimeDatabase, runSqliteMigrations, ensureDefaultSitesSeeded });

      expect(config.candyProbeScheduleEnabled).toBe(true);
      storeModule.recordCandyProbeResult(buildResult(424243));
      const afterReset = storeModule.getCandyProbeSnapshots([424243])[String(424243)]!;
      expect(Date.parse(afterReset.expiresAt) - Date.parse(afterReset.checkedAt)).toBeGreaterThan(60 * 60 * 1000);
    } finally {
      if (originalEnv === undefined) delete process.env.CANDY_PROBE_SCHEDULE_ENABLED;
      else process.env.CANDY_PROBE_SCHEDULE_ENABLED = originalEnv;
      config.candyProbeScheduleEnabled = originalEnabled;
      schedulerModule.resetCandyProbeSchedulerForTests();
    }
  });
});
