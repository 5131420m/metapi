import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

const sendNotificationMock = vi.fn();

vi.mock('./notifyService.js', () => ({
  sendNotification: (...args: unknown[]) => sendNotificationMock(...args),
}));

type DbModule = typeof import('../db/index.js');
type AlertServiceModule = typeof import('./alertService.js');
type StreakModule = typeof import('./accountAuthFailureStreak.js');
type TokenRouterModule = typeof import('./tokenRouter.js');

describe('alertService auth-expiry guardrails', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let reportTokenExpired: AlertServiceModule['reportTokenExpired'];
  let noteAccountAuthFailureSuspected: AlertServiceModule['noteAccountAuthFailureSuspected'];
  let flushModelImpactAlerts: AlertServiceModule['__flushModelImpactAlertsForTests'];
  let registerAccountAuthFailure: StreakModule['registerAccountAuthFailure'];
  let resetAccountAuthFailureStreak: StreakModule['resetAccountAuthFailureStreak'];
  let claimAccountAuthSuspicionReport: StreakModule['claimAccountAuthSuspicionReport'];
  let resetSuspicionReports: StreakModule['__resetAccountAuthSuspicionReportsForTests'];
  let invalidateTokenRouterCache: TokenRouterModule['invalidateTokenRouterCache'];
  let dataDir = '';
  let idSeed = 0;

  const nextId = () => {
    idSeed += 1;
    return idSeed;
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-alert-auth-expiry-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const alertServiceModule = await import('./alertService.js');
    const streakModule = await import('./accountAuthFailureStreak.js');
    const tokenRouterModule = await import('./tokenRouter.js');
    db = dbModule.db;
    schema = dbModule.schema;
    reportTokenExpired = alertServiceModule.reportTokenExpired;
    noteAccountAuthFailureSuspected = alertServiceModule.noteAccountAuthFailureSuspected;
    flushModelImpactAlerts = alertServiceModule.__flushModelImpactAlertsForTests;
    registerAccountAuthFailure = streakModule.registerAccountAuthFailure;
    resetAccountAuthFailureStreak = streakModule.resetAccountAuthFailureStreak;
    claimAccountAuthSuspicionReport = streakModule.claimAccountAuthSuspicionReport;
    resetSuspicionReports = streakModule.__resetAccountAuthSuspicionReportsForTests;
    invalidateTokenRouterCache = tokenRouterModule.invalidateTokenRouterCache;
  });

  beforeEach(async () => {
    idSeed = 0;
    sendNotificationMock.mockReset();
    resetSuspicionReports();
    // Fixtures insert routes directly; the router's route cache must not serve a
    // stale snapshot to the model-impact check.
    invalidateTokenRouterCache();
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.events).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
  });

  async function createAccountFixture(namePrefix: string) {
    const site = await db.insert(schema.sites).values({
      name: `${namePrefix}-site-${nextId()}`,
      url: `https://${namePrefix}-${nextId()}.example.com`,
      platform: 'new-api',
      status: 'active',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: `${namePrefix}-user-${nextId()}`,
      accessToken: `access-${nextId()}`,
      apiToken: `sk-${nextId()}`,
      status: 'active',
    }).returning().get();
    return { site, account };
  }

  async function fetchAccountStatus(accountId: number) {
    const row = await db.select({ status: schema.accounts.status })
      .from(schema.accounts)
      .where(eq(schema.accounts.id, accountId)).get();
    return row?.status ?? null;
  }

  async function fetchEvents() {
    return db.select().from(schema.events).all();
  }

  it('keeps the account active on a single auth failure and only writes a warning event', async () => {
    const { account, site } = await createAccountFixture('single-strike');

    await reportTokenExpired({
      accountId: account.id,
      username: account.username,
      siteName: site.name,
      detail: 'HTTP 401',
    });

    expect(await fetchAccountStatus(account.id)).toBe('active');
    const events = await fetchEvents();
    expect(events.some((event) => event.title === '凭据疑似失效（未确认）')).toBe(true);
    expect(events.some((event) => event.title === 'Token 已失效')).toBe(false);
    expect(sendNotificationMock).not.toHaveBeenCalled();
  });

  it('marks the account expired on the second consecutive auth failure', async () => {
    const { account, site } = await createAccountFixture('double-strike');

    await reportTokenExpired({ accountId: account.id, username: account.username, siteName: site.name, detail: 'HTTP 401' });
    await reportTokenExpired({ accountId: account.id, username: account.username, siteName: site.name, detail: 'HTTP 401' });
    // The model-impact scan is detached from the caller; wait for it before asserting.
    await flushModelImpactAlerts();

    expect(await fetchAccountStatus(account.id)).toBe('expired');
    const events = await fetchEvents();
    expect(events.some((event) => event.title === 'Token 已失效')).toBe(true);
    expect(sendNotificationMock).toHaveBeenCalledWith(
      'Token 已失效',
      expect.stringContaining(account.username ?? ''),
      'error',
    );
  });

  it('restarts the streak after a successful request resets it', async () => {
    const { account, site } = await createAccountFixture('reset-streak');

    await reportTokenExpired({ accountId: account.id, username: account.username, siteName: site.name, detail: 'HTTP 401' });
    // A success between the two failures proves the credential still works.
    resetAccountAuthFailureStreak(account.id);
    await reportTokenExpired({ accountId: account.id, username: account.username, siteName: site.name, detail: 'HTTP 401' });

    expect(await fetchAccountStatus(account.id)).toBe('active');
  });

  it('expires again after re-activation only on a fresh pair of consecutive failures', async () => {
    const { account, site } = await createAccountFixture('reactivation');
    await reportTokenExpired({ accountId: account.id, username: account.username, siteName: site.name, detail: 'HTTP 401' });
    await reportTokenExpired({ accountId: account.id, username: account.username, siteName: site.name, detail: 'HTTP 401' });
    expect(await fetchAccountStatus(account.id)).toBe('expired');

    // Human re-activates the account; the confirmed streak must not linger.
    await db.update(schema.accounts).set({ status: 'active' })
      .where(eq(schema.accounts.id, account.id)).run();
    await reportTokenExpired({ accountId: account.id, username: account.username, siteName: site.name, detail: 'HTTP 401' });
    expect(await fetchAccountStatus(account.id)).toBe('active');
  });

  it('treats background-probe auth errors as suspicion only, never expiring the account', async () => {
    const { account, site } = await createAccountFixture('background');

    await noteAccountAuthFailureSuspected({
      accountId: account.id,
      username: account.username,
      siteName: site.name,
      detail: 'HTTP 401',
    });
    // Repeated background suspicion still never owns the hard transition.
    await noteAccountAuthFailureSuspected({
      accountId: account.id,
      username: account.username,
      siteName: site.name,
      detail: 'HTTP 401',
    });

    expect(await fetchAccountStatus(account.id)).toBe('active');
    const events = await fetchEvents();
    // The account stays active and keeps being probed, so the repeat inside the report window
    // must not append a second row (it would otherwise recur on every scheduled pass).
    expect(events.filter((event) => event.title === '后台任务凭据疑似失效').length).toBe(1);
    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
    expect(events.some((event) => event.title === 'Token 已失效')).toBe(false);
    expect(sendNotificationMock).toHaveBeenCalledWith(
      '后台任务凭据疑似失效',
      expect.stringContaining('未改变账号可用性'),
      'warning',
    );
  });

  it('names the models that lose their last credential when the account expires', async () => {
    const { site, account } = await createAccountFixture('model-death');
    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-model-death',
      enabled: true,
    }).returning().get();
    // Session-mode channel (no fixed token): account status gates its eligibility.
    await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      tokenId: null,
      priority: 0,
      weight: 10,
      enabled: true,
    }).run();

    await reportTokenExpired({ accountId: account.id, username: account.username, siteName: site.name, detail: 'HTTP 401' });
    await reportTokenExpired({ accountId: account.id, username: account.username, siteName: site.name, detail: 'HTTP 401' });
    // The model-impact scan is detached from the caller; wait for it before asserting.
    await flushModelImpactAlerts();

    expect(await fetchAccountStatus(account.id)).toBe('expired');
    const events = await fetchEvents();
    const modelDeathEvent = events.find((event) => event.title === '模型因凭据失效不再可用');
    expect(modelDeathEvent).toBeTruthy();
    expect(modelDeathEvent?.message).toContain('gpt-model-death');
    expect(sendNotificationMock).toHaveBeenCalledWith(
      '模型因凭据失效不再可用',
      expect.stringContaining('gpt-model-death'),
      'error',
    );
  });

  it('does not raise the model-death alert when another active channel survives', async () => {
    const { site, account } = await createAccountFixture('model-survives');
    const survivor = await createAccountFixture('model-survives-other');
    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-model-survives',
      enabled: true,
    }).returning().get();
    await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      tokenId: null,
      priority: 0,
      weight: 10,
      enabled: true,
    }).run();
    await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: survivor.account.id,
      tokenId: null,
      priority: 0,
      weight: 10,
      enabled: true,
    }).run();

    await reportTokenExpired({ accountId: account.id, username: account.username, siteName: site.name, detail: 'HTTP 401' });
    await reportTokenExpired({ accountId: account.id, username: account.username, siteName: site.name, detail: 'HTTP 401' });
    // The model-impact scan is detached from the caller; wait for it before asserting.
    await flushModelImpactAlerts();

    expect(await fetchAccountStatus(account.id)).toBe('expired');
    const events = await fetchEvents();
    expect(events.some((event) => event.title === '模型因凭据失效不再可用')).toBe(false);
  });

  it('suspicion window: reports once per account per window, independently per account', () => {
    const t0 = 1_700_000_000_000;
    expect(claimAccountAuthSuspicionReport(424242, t0)).toBe(true);
    expect(claimAccountAuthSuspicionReport(424242, t0 + 60 * 60 * 1000)).toBe(false);
    // Another account is not throttled by the first.
    expect(claimAccountAuthSuspicionReport(434343, t0 + 60 * 60 * 1000)).toBe(true);
    // After the window the same account is reported again.
    expect(claimAccountAuthSuspicionReport(424242, t0 + 6 * 60 * 60 * 1000)).toBe(true);
  });

  it('streak module: a strike older than the stale window no longer counts', () => {
    const accountId = 987654;
    resetAccountAuthFailureStreak(accountId);
    const t0 = 1_700_000_000_000;
    expect(registerAccountAuthFailure(accountId, t0)).toBe(false);
    // 40 minutes later: the previous strike expired, this is a fresh first strike.
    expect(registerAccountAuthFailure(accountId, t0 + 40 * 60 * 1000)).toBe(false);
    // Within the window, the second strike confirms.
    expect(registerAccountAuthFailure(accountId, t0 + 41 * 60 * 1000)).toBe(true);
    resetAccountAuthFailureStreak(accountId);
  });
});
