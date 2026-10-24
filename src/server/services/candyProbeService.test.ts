import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CANDY_BAG_REFERENCE_QUESTION } from './candyProbe/candyBagQuestion.js';

type DbModule = typeof import('../db/index.js');

const {
  resolveUpstreamEndpointCandidatesMock,
  dispatchRuntimeRequestMock,
  resolveChannelProxyUrlMock,
  withSiteRecordProxyRequestInitMock,
  getOauthInfoFromAccountMock,
  buildOauthProviderHeadersMock,
  insertProxyLogMock,
} = vi.hoisted(() => ({
  resolveUpstreamEndpointCandidatesMock: vi.fn(),
  dispatchRuntimeRequestMock: vi.fn(),
  resolveChannelProxyUrlMock: vi.fn(),
  withSiteRecordProxyRequestInitMock: vi.fn(),
  getOauthInfoFromAccountMock: vi.fn(),
  buildOauthProviderHeadersMock: vi.fn(),
  insertProxyLogMock: vi.fn(),
}));

/** Delegating spy: defaults to the real writer so the audit rows are really persisted. */
let realInsertProxyLog: typeof import('./proxyLogStore.js')['insertProxyLog'];

vi.mock('./proxyLogStore.js', async () => {
  const actual = await vi.importActual<typeof import('./proxyLogStore.js')>('./proxyLogStore.js');
  realInsertProxyLog = actual.insertProxyLog;
  return {
    ...actual,
    insertProxyLog: (...args: Parameters<typeof actual.insertProxyLog>) => insertProxyLogMock(...args),
  };
});

vi.mock('./upstreamEndpointRuntime.js', async () => {
  const actual = await vi.importActual<typeof import('./upstreamEndpointRuntime.js')>('./upstreamEndpointRuntime.js');
  return {
    ...actual,
    resolveUpstreamEndpointCandidates: (...args: unknown[]) => resolveUpstreamEndpointCandidatesMock(...args),
  };
});

/**
 * Pin the question to the reference bag for this file.
 *
 * The subject here is the probe's orchestration (usage log, debug trace, deadlines, single
 * flight, sampling), not the question: a randomly drawn generated bag would make every
 * expectation depend on a random draw. The generated bags have their own tests, where their
 * answers are checked against brute-force enumeration.
 */
vi.mock('./candyProbe/generatedQuestions.js', () => ({
  generateCandyBagQuestion: () => null,
}));

vi.mock('./runtimeDispatch.js', () => ({
  dispatchRuntimeRequest: (...args: unknown[]) => dispatchRuntimeRequestMock(...args),
}));

vi.mock('./siteProxy.js', () => ({
  resolveChannelProxyUrl: (...args: unknown[]) => resolveChannelProxyUrlMock(...args),
  withSiteRecordProxyRequestInit: (...args: unknown[]) => withSiteRecordProxyRequestInitMock(...args),
}));

vi.mock('./oauth/oauthAccount.js', () => ({
  getOauthInfoFromAccount: (...args: unknown[]) => getOauthInfoFromAccountMock(...args),
}));

vi.mock('./oauth/service.js', () => ({
  buildOauthProviderHeaders: (...args: unknown[]) => buildOauthProviderHeadersMock(...args),
}));

/** The reference question's answer, and a plainly wrong one, as the probe reads them. */
const CORRECT_ANSWER = `答案：${CANDY_BAG_REFERENCE_QUESTION.expectedLabel}`;
const WRONG_ANSWER = '答案：20';
/** No number at all: a refusal or prose, which must never count as a wrong answer. */
const UNREADABLE_ANSWER = '我无法完成这个题目。';

function sseChatText(text: string, model = 'bench-model'): string {
  const chunks = text.split('\n').map((line, index, all) => (
    `data: ${JSON.stringify({
      model,
      choices: [{ delta: { content: index === all.length - 1 ? line : `${line}\n` }, finish_reason: null }],
    })}\n\n`
  ));
  return `${chunks.join('')}data: [DONE]\n\n`;
}

/**
 * One fixture builder for every describe in this file.
 *
 * It lives at module scope because two describes need it, and a second copy immediately
 * drifted: the copy forgot the NOT NULL `accounts.access_token` and every insert failed.
 */
async function seedProbeChannelFixture(
  modules: { db: DbModule['db']; schema: DbModule['schema'] },
  nextId: () => number,
  input: {
    sourceModel?: string | null;
    modelPattern?: string;
    platform?: string;
    withToken?: boolean;
    apiToken?: string;
  } = {},
) {
  const { db, schema } = modules;
  const seedId = nextId();
  const site = await db.insert(schema.sites).values({
    name: `candy-site-${seedId}`,
    url: `https://candy-${seedId}.example.com`,
    platform: input.platform ?? 'new-api',
    status: 'active',
  }).returning().get();
  const account = await db.insert(schema.accounts).values({
    siteId: site.id,
    username: 'candy-user',
    accessToken: '',
    apiToken: input.apiToken ?? 'sk-candy',
    status: 'active',
  }).returning().get();
  const token = input.withToken === false
    ? null
    : await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'candy-token',
      token: 'token-candy',
      enabled: true,
      isDefault: false,
    }).returning().get();
  // `token_routes.model_pattern` is unique, so a per-seed suffix keeps fixtures independent
  // without changing what the service resolves (sourceModel wins when present).
  const route = await db.insert(schema.tokenRoutes).values({
    modelPattern: input.modelPattern ?? `${input.sourceModel || 'claude-sonnet-4-5'}@${Math.random().toString(36).slice(2, 8)}`,
    enabled: true,
  }).returning().get();
  const channel = await db.insert(schema.routeChannels).values({
    routeId: route.id,
    accountId: account.id,
    tokenId: token?.id ?? null,
    sourceModel: input.sourceModel === undefined ? 'claude-sonnet-4-5' : input.sourceModel,
    priority: 0,
    weight: 10,
    enabled: true,
  }).returning().get();
  return { site, account, token, route, channel };
}

describe('runChannelCandyProbe', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';
  let seedCounter = 0;
  let service: typeof import('./candyProbeService.js');
  let store: typeof import('./candyProbe/resultStore.js');

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-candy-probe-'));
    process.env.DATA_DIR = dataDir;
    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    db = dbModule.db;
    schema = dbModule.schema;
    service = await import('./candyProbeService.js');
    store = await import('./candyProbe/resultStore.js');
  });

  beforeEach(async () => {
    store.resetCandyProbeStoreForTests();
    service.resetCandyProbeConcurrencyForTests();
    resolveUpstreamEndpointCandidatesMock.mockReset().mockResolvedValue(['chat']);
    dispatchRuntimeRequestMock.mockReset();
    resolveChannelProxyUrlMock.mockReset().mockReturnValue(null);
    withSiteRecordProxyRequestInitMock.mockReset().mockImplementation(async (_site: unknown, init: unknown) => init);
    getOauthInfoFromAccountMock.mockReset().mockReturnValue(null);
    buildOauthProviderHeadersMock.mockReset().mockReturnValue({});
    insertProxyLogMock.mockReset().mockImplementation(
      (input: Parameters<typeof realInsertProxyLog>[0]) => realInsertProxyLog(input),
    );

    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    // Pool endpoints redirect every probe the site runs, so a row leaked from one test
    // would silently change which base URL the next test's probe targets.
    await db.delete(schema.siteApiEndpoints).run();
    await db.delete(schema.sites).run();
    await db.delete(schema.settings).run();
    await db.delete(schema.proxyLogs).run();
    await db.delete(schema.proxyDebugAttempts).run();
    await db.delete(schema.proxyDebugTraces).run();
  });

  afterAll(() => {
    store.resetCandyProbeStoreForTests();
    // Windows keeps the SQLite file handle open; a failed temp-dir cleanup must not fail the run.
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    delete process.env.DATA_DIR;
  });

  async function seedChannel(input: {
    sourceModel?: string | null;
    modelPattern?: string;
    platform?: string;
    withToken?: boolean;
    apiToken?: string;
  } = {}) {
    return seedProbeChannelFixture({ db, schema }, () => ++seedCounter, input);
  }

  it('records a pass when the model answers correctly', async () => {
    const { channel } = await seedChannel();
    dispatchRuntimeRequestMock.mockImplementation(async () => new Response(sseChatText(CORRECT_ANSWER), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }));

    // `random: () => 0` pins the reference bag (see selectCandyBagQuestion).
    const result = await service.runChannelCandyProbe({ channelId: channel.id, random: () => 0 });

    expect(result.verdict).toBe('pass');
    expect(result.score).toBe(1);
    expect(result.total).toBe(1);
    expect(result.validSampleCount).toBe(1);
    expect(result.fingerprint).toBe('claude_code');
    expect(result.endpoint).toBe('chat');
    expect(result.actualModel).toBe('bench-model');
    // One question, one request, one answer.
    expect(result.samples).toHaveLength(1);
    expect(result.samples[0]?.correct).toBe(true);
    expect(dispatchRuntimeRequestMock).toHaveBeenCalledTimes(1);
    expect(result.question.id).toBe(CANDY_BAG_REFERENCE_QUESTION.id);
  });

  it('records a fail when the model commits to a wrong answer', async () => {
    const { channel } = await seedChannel();
    dispatchRuntimeRequestMock.mockImplementation(async () => new Response(sseChatText(WRONG_ANSWER), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }));

    const result = await service.runChannelCandyProbe({ channelId: channel.id, random: () => 0 });

    expect(result.verdict).toBe('fail');
    expect(result.score).toBe(0);
    expect(result.reason).toContain('答案为');
    // The near miss is named, so the panel can say WHICH wrong answer came back.
    expect(result.samples[0]?.note).toContain('20');
  });

  it('returns an ambiguous answer as inconclusive, never as a pass', async () => {
    const { channel } = await seedChannel();
    dispatchRuntimeRequestMock.mockImplementation(async () => new Response(sseChatText('答案：20 或 21'), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }));

    const result = await service.runChannelCandyProbe({ channelId: channel.id, random: () => 0 });

    expect(result.verdict).toBe('inconclusive');
    expect(result.validSampleCount).toBe(0);
  });

  it('counts a stalled upstream as inconclusive, not as a wrong answer', async () => {
    const { channel } = await seedChannel();
    // A stream that never enqueues a byte: the run must end at its deadline, unanswered.
    dispatchRuntimeRequestMock.mockImplementation(async () => new Response(
      new ReadableStream<Uint8Array>({ start() { /* never enqueue, never close */ } }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ));

    const result = await service.runChannelCandyProbe({
      channelId: channel.id,
      random: () => 0,
      timeoutMs: 400,
    });

    expect(result.verdict).toBe('inconclusive');
    expect(result.validSampleCount).toBe(0);
    expect(dispatchRuntimeRequestMock).toHaveBeenCalledTimes(1);
  });

  it('does not convict on wrong numbers read out of prose fallbacks', async () => {
    const { channel } = await seedChannel();
    // The reviewer's reported false alarm: the model omits the 「答案：」 line and ends its
    // reasoning with the split. The old reader took the trailing 12 as a wrong answer; a
    // prose read that misses the answer cannot be the basis of a fail.
    dispatchRuntimeRequestMock.mockImplementation(async () => new Response(sseChatText('圆形至少 9 颗，五角星至少 12 颗。'), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }));

    const result = await service.runChannelCandyProbe({ channelId: channel.id, random: () => 0 });

    expect(result.verdict).toBe('inconclusive');
    expect(result.validSampleCount).toBe(0);
    expect(result.samples).toHaveLength(1);
    expect(result.samples[0]?.note).toContain('样本记为无效');
  });

  it('counts consecutive bad verdicts for the schedule backoff, and resets on a pass', async () => {
    const { channel } = await seedChannel();
    let answer = WRONG_ANSWER;
    dispatchRuntimeRequestMock.mockImplementation(async () => new Response(sseChatText(answer), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }));

    const first = await service.runChannelCandyProbe({ channelId: channel.id, random: () => 0 });
    expect(first.verdict).toBe('fail');
    expect(first.failStreak).toBe(1);

    const second = await service.runChannelCandyProbe({ channelId: channel.id, random: () => 0 });
    expect(second.verdict).toBe('fail');
    expect(second.failStreak).toBe(2);

    answer = CORRECT_ANSWER;
    const third = await service.runChannelCandyProbe({ channelId: channel.id, random: () => 0 });
    expect(third.verdict).toBe('pass');
    expect(third.failStreak).toBe(0);
  });

  it('asks one question, and allows reasoning before the answer line', async () => {
    const { channel } = await seedChannel();
    let seenPrompt = '';
    dispatchRuntimeRequestMock.mockImplementation(async (input: {
      request: { body: Record<string, any> };
    }) => {
      const body = input.request.body;
      seenPrompt = String(
        body?.messages?.[0]?.content?.[0]?.text
        ?? body?.messages?.[0]?.content
        ?? body?.input?.[0]?.content?.[0]?.text
        ?? '',
      );
      return new Response(sseChatText([
        '先看最坏情况：如果一颗桃子都摸不到，那么只摸圆形是不行的。',
        CORRECT_ANSWER,
      ].join('\n')), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });

    const result = await service.runChannelCandyProbe({ channelId: channel.id, random: () => 0 });

    // One question per request, and the instruction invites reasoning.
    expect(seenPrompt).toContain(CANDY_BAG_REFERENCE_QUESTION.prompt);
    expect(seenPrompt).toContain('可以写推理过程');
    expect(result.verdict).toBe('pass');
  });

  it('grades an answer that explains the split next to the conclusion', async () => {
    const { channel } = await seedChannel();
    // The reported false negative: the old rule took the LAST number, so `12` displaced 21.
    dispatchRuntimeRequestMock.mockImplementation(async () => new Response(
      sseChatText('答案：21（圆形 9 颗 + 五角星形 12 颗）'),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ));

    const result = await service.runChannelCandyProbe({ channelId: channel.id, random: () => 0 });

    expect(result.verdict).toBe('pass');
    expect(result.samples.every((sample) => sample.correct)).toBe(true);
  });

  it('never touches channel health: routing state stays clean after a failing verdict', async () => {
    const { channel } = await seedChannel();
    dispatchRuntimeRequestMock.mockImplementation(async () => new Response(
      sseChatText(WRONG_ANSWER),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ));

    const result = await service.runChannelCandyProbe({ channelId: channel.id, random: () => 0 });
    expect(result.verdict).toBe('fail');

    const stored = await db.select().from(schema.routeChannels).get();
    expect(stored?.cooldownUntil ?? null).toBeNull();
    expect(stored?.cooldownSource ?? null).toBeNull();
    expect(stored?.consecutiveFailCount ?? 0).toBe(0);
    expect(stored?.failCount ?? 0).toBe(0);
    expect(stored?.lastFailAt ?? null).toBeNull();
  });

  it('reports an upstream error as inconclusive rather than degraded', async () => {
    const { channel } = await seedChannel();
    dispatchRuntimeRequestMock.mockImplementation(async () => new Response(
      JSON.stringify({ error: { message: 'model not found' } }),
      { status: 404, headers: { 'content-type': 'application/json' } },
    ));

    const result = await service.runChannelCandyProbe({ channelId: channel.id, random: () => 0 });

    expect(result.verdict).toBe('inconclusive');
    expect(result.reason).toContain('404');
    expect(result.reason).toContain('model not found');
  });

  it('never convicts a fragment cut off by a mid-stream error event', async () => {
    const { channel } = await seedChannel();
    // "答案：2" of a 21, then the relay reports an error and closes: no stop reason at all.
    // Grading the fragment would read a committed wrong answer and call the model degraded.
    dispatchRuntimeRequestMock.mockImplementation(async () => new Response(
      [
        `data: ${JSON.stringify({ choices: [{ delta: { content: '答案：2' }, finish_reason: null }] })}`,
        '',
        `data: ${JSON.stringify({ error: { message: 'upstream overloaded' } })}`,
        '',
        '',
      ].join('\n'),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ));

    const result = await service.runChannelCandyProbe({ channelId: channel.id, random: () => 0 });

    expect(result.verdict).toBe('inconclusive');
    expect(result.reason).toContain('上游流报错');
    expect(result.reason).toContain('upstream overloaded');
  });

  it('reports an empty completion as inconclusive, not as degradation', async () => {
    const { channel } = await seedChannel();
    dispatchRuntimeRequestMock.mockImplementation(async () => new Response('', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }));

    const result = await service.runChannelCandyProbe({ channelId: channel.id, random: () => 0 });

    expect(result.verdict).toBe('inconclusive');
    expect(result.reason).toContain('没有可判读的答案');
  });

  it('does not hang when the upstream stalls mid-stream', async () => {
    const { channel } = await seedChannel();
    // Headers arrive, then the body never ends: the exact shape that used to hang the
    // probe forever because the abort timer was cleared before the body read.
    dispatchRuntimeRequestMock.mockImplementation(async () => new Response(
      new ReadableStream<Uint8Array>({ start() { /* never enqueue, never close */ } }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ));

    const startedAt = Date.now();
    const result = await service.runChannelCandyProbe({
      channelId: channel.id,
      random: () => 0,
      timeoutMs: 400,
    });
    const elapsedMs = Date.now() - startedAt;

    expect(result.verdict).toBe('inconclusive');
    // The timeout has to survive into the verdict text: "no readable answer" alone would hide
    // the difference between a dead channel and a model that answered something unparseable.
    expect(result.reason).toContain('探测超时');
    expect(elapsedMs).toBeLessThan(5_000);
  });

  it('ends the run at its deadline when the upstream stalls, unanswered', async () => {
    const { channel } = await seedChannel();
    // A run is one request: discovery plus the request share the single deadline, and a
    // stalled body must end the run at that deadline rather than hang forever.
    resolveUpstreamEndpointCandidatesMock.mockResolvedValue(['chat']);
    dispatchRuntimeRequestMock.mockImplementation(async () => new Response(
      new ReadableStream<Uint8Array>({ start() { /* never enqueue, never close */ } }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ));

    const result = await service.runChannelCandyProbe({
      channelId: channel.id,
      random: () => 0,
      timeoutMs: 1_000,
    });

    expect(result.verdict).toBe('inconclusive');
    expect(result.total).toBe(1);
    expect(result.validSampleCount).toBe(0);
    expect(result.reason).toContain('探测超时');
    expect(dispatchRuntimeRequestMock).toHaveBeenCalledTimes(1);
  });

  it('follows the site API endpoint pool and rotates past a dead endpoint', async () => {
    const { channel, site } = await seedChannel();
    await db.insert(schema.siteApiEndpoints).values([
      { siteId: site.id, url: 'https://pool-a.example.com', enabled: true, sortOrder: 0 },
      { siteId: site.id, url: 'https://pool-b.example.com', enabled: true, sortOrder: 1 },
    ]).run();
    // The first pool target is unreachable at the transport layer — the exact shape that
    // used to end the run as fetch failed — while the second answers correctly.
    dispatchRuntimeRequestMock.mockImplementation(async (input: { targetUrl?: string }) => {
      if (String(input.targetUrl || '').includes('pool-a')) {
        throw new TypeError('fetch failed');
      }
      return new Response(sseChatText(CORRECT_ANSWER), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });

    const result = await service.runChannelCandyProbe({ channelId: channel.id, random: () => 0 });

    expect(result.verdict).toBe('pass');
    expect(dispatchRuntimeRequestMock).toHaveBeenCalledTimes(2);
    const targetUrls = dispatchRuntimeRequestMock.mock.calls
      .map((call) => String((call[0] as { targetUrl?: string }).targetUrl || ''));
    expect(targetUrls[0]).toContain('pool-a.example.com');
    expect(targetUrls[1]).toContain('pool-b.example.com');
    // The probe's failure feeds the pool's cooldown state, exactly like a real request's.
    const endpoints = await db.select().from(schema.siteApiEndpoints).all();
    const dead = endpoints.find((row) => row.url.includes('pool-a'));
    const alive = endpoints.find((row) => row.url.includes('pool-b'));
    expect(dead?.lastFailedAt).toBeTruthy();
    expect(alive?.lastSelectedAt).toBeTruthy();
  });

  it('does not rotate a 4xx business failure, and still logs its status', async () => {
    const { channel, site } = await seedChannel();
    await db.insert(schema.siteApiEndpoints).values([
      { siteId: site.id, url: 'https://pool-a.example.com', enabled: true, sortOrder: 0 },
      { siteId: site.id, url: 'https://pool-b.example.com', enabled: true, sortOrder: 1 },
    ]).run();
    // A 404 is the model's answer about itself (no such model), not the endpoint's: trying
    // another endpoint would just ask the same question of the same mistake.
    dispatchRuntimeRequestMock.mockImplementation(async () => new Response('no such model', { status: 404 }));

    const result = await service.runChannelCandyProbe({ channelId: channel.id, random: () => 0 });

    expect(result.verdict).toBe('inconclusive');
    expect(dispatchRuntimeRequestMock).toHaveBeenCalledTimes(1);
    expect(result.reason).toContain('404');
    const log = (await db.select().from(schema.proxyLogs).all())[0];
    expect(log.status).toBe('failed');
    expect(log.httpStatus).toBe(404);
  });

  it('ends the run at its deadline without rotating, in the probe\'s own wording', async () => {
    const { channel, site } = await seedChannel();
    await db.insert(schema.siteApiEndpoints).values([
      { siteId: site.id, url: 'https://pool-a.example.com', enabled: true, sortOrder: 0 },
      { siteId: site.id, url: 'https://pool-b.example.com', enabled: true, sortOrder: 1 },
    ]).run();
    dispatchRuntimeRequestMock.mockImplementation(async () => new Response(
      new ReadableStream<Uint8Array>({ start() { /* never enqueue, never close */ } }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ));

    const result = await service.runChannelCandyProbe({
      channelId: channel.id,
      random: () => 0,
      timeoutMs: 400,
    });

    // The deadline is the run's, not per-endpoint: once it is gone there is no budget left
    // for another target, and the pool rethrows without rotating.
    expect(result.verdict).toBe('inconclusive');
    expect(result.reason).toContain('探测超时');
    expect(dispatchRuntimeRequestMock).toHaveBeenCalledTimes(1);
  });

  it('counts against the site concurrency lease like a real request', async () => {
    const { channel, site } = await seedChannel();
    await db.update(schema.sites)
      .set({ maxConcurrency: 1 })
      .where(eq(schema.sites.id, site.id))
      .run();
    const coordinator = await import('./proxyChannelCoordinator.js');
    // The site's single slot is held by "real traffic" — the probe must queue behind it and
    // end 未完成 rather than barge past the same gate a real request respects.
    const held = await coordinator.proxyChannelCoordinator.acquireSiteLease({
      siteId: site.id,
      maxConcurrency: 1,
    });
    if (held.status !== 'acquired') {
      throw new Error('test setup failed to hold the site lease');
    }
    dispatchRuntimeRequestMock.mockImplementation(async () => new Response(sseChatText(CORRECT_ANSWER), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }));

    try {
      const result = await service.runChannelCandyProbe({ channelId: channel.id, random: () => 0 });
      expect(result.verdict).toBe('inconclusive');
      expect(result.reason).toContain('Site busy');
      expect(dispatchRuntimeRequestMock).not.toHaveBeenCalled();
    } finally {
      held.lease.release();
    }
  });

  it('gives up on a saturated site immediately when scheduled, not after the queue wait', async () => {
    const { channel, site } = await seedChannel();
    await db.update(schema.sites)
      .set({ maxConcurrency: 1 })
      .where(eq(schema.sites.id, site.id))
      .run();
    const coordinator = await import('./proxyChannelCoordinator.js');
    const held = await coordinator.proxyChannelCoordinator.acquireSiteLease({
      siteId: site.id,
      maxConcurrency: 1,
    });
    if (held.status !== 'acquired') {
      throw new Error('test setup failed to hold the site lease');
    }
    dispatchRuntimeRequestMock.mockImplementation(async () => new Response(sseChatText(CORRECT_ANSWER), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }));

    try {
      // A scheduled probe must not sit in the site's queue behind real traffic; it gives
      // up at once. Nothing was asked upstream, so nothing is recorded: the previous
      // verdict stands and no usage-log row is written — the sweep skips the channel.
      const startedAt = Date.now();
      await expect(service.runChannelCandyProbe({
        channelId: channel.id,
        random: () => 0,
        trigger: 'schedule',
      })).rejects.toThrow('Site busy');
      expect(Date.now() - startedAt).toBeLessThan(100);
      expect(dispatchRuntimeRequestMock).not.toHaveBeenCalled();
      expect(store.getCandyProbeResultForChannel(channel.id)).toBeNull();
      expect(await db.select().from(schema.proxyLogs).all()).toHaveLength(0);
    } finally {
      held.lease.release();
    }
  });

  it('requests the upstream URL, never the forwarding proxy address, when the site has one', async () => {
    const { channel, site } = await seedChannel();
    // A forwarding proxy is a dispatcher, not a destination: the request must still target
    // the site (or pool endpoint) URL, with the proxy injected only through buildInit.
    resolveChannelProxyUrlMock.mockReturnValue('http://127.0.0.1:7890');
    dispatchRuntimeRequestMock.mockImplementation(async (input: {
      targetUrl?: string;
      request?: unknown;
      buildInit?: (requestUrl: string, request: unknown) => Promise<unknown>;
    }) => {
      // performFetch builds the fetch init before requesting; mirror it so the proxy
      // injection in buildInit is actually exercised.
      if (input.buildInit) await input.buildInit(String(input.targetUrl || ''), input.request);
      return new Response(sseChatText(CORRECT_ANSWER), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });

    const result = await service.runChannelCandyProbe({ channelId: channel.id, random: () => 0 });

    expect(result.verdict).toBe('pass');
    const dispatchInput = dispatchRuntimeRequestMock.mock.calls[0]?.[0] as { targetUrl?: string };
    expect(dispatchInput.targetUrl).toContain(site.url.replace(/\/+$/, ''));
    expect(dispatchInput.targetUrl).not.toContain('127.0.0.1:7890');
    // The proxy is still very much in play — as the dispatcher buildInit hands to fetch.
    const proxyInit = withSiteRecordProxyRequestInitMock.mock.calls
      .find((call) => String(call[2] || '').includes('127.0.0.1:7890'));
    expect(proxyInit).toBeTruthy();
  });

  it('targets the pool endpoint through a site proxy, and records no failure on a pass', async () => {
    const { channel, site } = await seedChannel();
    await db.insert(schema.siteApiEndpoints).values([
      { siteId: site.id, url: 'https://pool-a.example.com', enabled: true, sortOrder: 0 },
    ]).run();
    resolveChannelProxyUrlMock.mockReturnValue('http://127.0.0.1:7890');
    dispatchRuntimeRequestMock.mockImplementation(async () => new Response(sseChatText(CORRECT_ANSWER), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }));

    const result = await service.runChannelCandyProbe({ channelId: channel.id, random: () => 0 });

    expect(result.verdict).toBe('pass');
    const dispatchInput = dispatchRuntimeRequestMock.mock.calls[0]?.[0] as { targetUrl?: string };
    expect(dispatchInput.targetUrl).toContain('pool-a.example.com');
    expect(dispatchInput.targetUrl).not.toContain('127.0.0.1:7890');
    // A pass must leave the pool endpoint's failure state untouched — the M1 bug recorded
    // proxy-address failures against endpoints whose upstream was never contacted.
    const endpoint = (await db.select().from(schema.siteApiEndpoints).all())[0];
    expect(endpoint?.lastFailedAt).toBeNull();
    expect(endpoint?.lastSelectedAt).toBeTruthy();
  });

  it('picks the Codex fingerprint for GPT models and the Codex chat variant for others', async () => {
    const { channel: gptChannel } = await seedChannel({ sourceModel: 'gpt-5.4' });
    dispatchRuntimeRequestMock.mockImplementation(async () => new Response('', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }));
    const gptResult = await service.runChannelCandyProbe({ channelId: gptChannel.id });
    expect(gptResult.fingerprint).toBe('codex');

    // The aggregator reality: non-GPT models arrive wearing a Codex-CLI identity on
    // /v1/chat/completions, so the probe wears that variant rather than a neutral SDK.
    const { channel: otherChannel } = await seedChannel({ sourceModel: 'deepseek-v3' });
    const otherResult = await service.runChannelCandyProbe({ channelId: otherChannel.id });
    expect(otherResult.fingerprint).toBe('codex_chat');
  });

  it('honours an explicit fingerprint override', async () => {
    const { channel } = await seedChannel({ sourceModel: 'deepseek-v3' });
    dispatchRuntimeRequestMock.mockImplementation(async () => new Response('', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }));

    const result = await service.runChannelCandyProbe({ channelId: channel.id, fingerprint: 'claude_code' });

    expect(result.fingerprint).toBe('claude_code');
  });

  it('sends the Claude Code identity when probing a Claude model', async () => {
    const { channel } = await seedChannel();
    // Claude traffic goes to the messages endpoint, which is where the Claude Code headers
    // and the Claude-shaped body are built.
    resolveUpstreamEndpointCandidatesMock.mockResolvedValue(['messages']);
    dispatchRuntimeRequestMock.mockImplementation(async (input: {
      request: { headers: Record<string, string>; body: Record<string, any> };
    }) => {
      // The body must carry the Claude Code identity line, and the headers its UA/x-app.
      expect(input.request.body.system[0].text).toContain('You are Claude Code');
      expect(input.request.body.metadata.user_id).toMatch(/^user_[0-9a-f]{64}_account__session_/);
      expect(input.request.headers['User-Agent']).toContain('claude-cli/');
      expect(input.request.headers['X-App']).toBe('cli');
      return new Response(sseChatText(WRONG_ANSWER), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });

    const result = await service.runChannelCandyProbe({ channelId: channel.id, random: () => 0 });
    // This test is about the fingerprint's wire path, not the verdict.
    expect(result.samples[0]?.correct).toBe(false);
    expect(result.verdict).toBe('fail');
    expect(result.endpoint).toBe('messages');
    expect(dispatchRuntimeRequestMock).toHaveBeenCalledTimes(1);
  });

  it('wears the Codex identity the site gives real traffic, not a forced one', async () => {
    const seeded = await seedChannel({ sourceModel: 'gpt-5.4' });
    // GPT models probe on /v1/responses, where the identity synthesis runs when enabled.
    resolveUpstreamEndpointCandidatesMock.mockResolvedValue(['responses']);
    let seen: { headers: Record<string, string>; body: Record<string, any> } | null = null;
    dispatchRuntimeRequestMock.mockImplementation(async (input: {
      request: { headers: Record<string, string>; body: Record<string, any> };
    }) => {
      seen = { headers: input.request.headers, body: input.request.body };
      return new Response('', { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });

    // Site default: identity synthesis OFF — the probe must carry no synthesized metadata,
    // exactly like the real traffic this site serves (the debian box runs 39/41 sites off).
    await service.runChannelCandyProbe({ channelId: seeded.channel.id, random: () => 0 });
    expect(seen?.body).not.toHaveProperty('client_metadata');
    expect(seen?.headers['x-codex-window-id']).toBeUndefined();
    expect(seen?.headers['x-codex-turn-metadata']).toBeUndefined();

    // The same site with synthesis ON: the probe wears the full identity, again matching
    // the site's real traffic.
    await db.update(schema.sites).set({ codexIdentityMode: 'synthesize' }).run();
    await service.runChannelCandyProbe({ channelId: seeded.channel.id, random: () => 0 });
    expect(seen?.body).toHaveProperty('client_metadata');
    expect(seen?.headers['x-codex-window-id']).toBeTruthy();
    expect(seen?.headers['x-codex-turn-metadata']).toBeTruthy();
  });

  it('rejects an unknown channel with a 404-style error', async () => {
    await expect(service.runChannelCandyProbe({ channelId: 999 })).rejects.toMatchObject({
      statusCode: 404,
    });
  });  it('rejects a channel without a probeable model name', async () => {
    const { channel } = await seedChannel({ sourceModel: null, modelPattern: '^claude-.*$' });
    await expect(service.runChannelCandyProbe({ channelId: channel.id })).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it('rejects non-conversation models', async () => {
    const { channel } = await seedChannel({ sourceModel: 'text-embedding-3-large' });
    await expect(service.runChannelCandyProbe({ channelId: channel.id })).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it('rejects a channel without usable credentials', async () => {
    // No bound token and no account credential at all: the probe cannot even start.
    const { channel } = await seedChannel({ withToken: false, apiToken: '' });
    await expect(service.runChannelCandyProbe({ channelId: channel.id })).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it('exposes the latest verdict through the snapshot getter', async () => {
    const { channel } = await seedChannel();
    dispatchRuntimeRequestMock.mockImplementation(async () => new Response(sseChatText(CORRECT_ANSWER), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }));

    await service.runChannelCandyProbe({ channelId: channel.id, random: () => 0 });
    const snapshots = service.getCandyProbeSnapshots([channel.id]);

    expect(snapshots[String(channel.id)]).toMatchObject({
      channelId: channel.id,
      verdict: 'pass',
      fresh: true,
    });
    // The list payload stays lean: the per-sample detail is fetched on demand.
    expect(snapshots[String(channel.id)]).not.toHaveProperty('samples');
  });

  it('writes one usage-log row per run, tagged as a candy probe and costing nothing', async () => {
    const { channel, account } = await seedChannel();
    dispatchRuntimeRequestMock.mockImplementation(async () => new Response(sseChatText(CORRECT_ANSWER), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }));

    await service.runChannelCandyProbe({ channelId: channel.id, random: () => 0 });

    const logs = await db.select().from(schema.proxyLogs).all();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      channelId: channel.id,
      accountId: account.id,
      routeId: channel.routeId,
      status: 'success',
      clientFamily: service.CANDY_PROBE_CLIENT_FAMILY,
      clientAppName: '糖果题检测',
      estimatedCost: 0,
    });
    expect(logs[0].errorMessage).toContain('糖果题判定');
    expect(logs[0].errorMessage).toContain('通过');
  });

  it('keeps the verdict out of the client columns so the log filters stay stable', async () => {
    // A reasoning model, so the note carries the degradation claim this test pins; the
    // client columns themselves must not.
    const { channel } = await seedChannel({ sourceModel: 'deepseek-r1' });
    dispatchRuntimeRequestMock.mockImplementation(async () => new Response(
      sseChatText(WRONG_ANSWER),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ));

    await service.runChannelCandyProbe({ channelId: channel.id, random: () => 0 });

    const log = (await db.select().from(schema.proxyLogs).all())[0];
    // The app name used to carry "疑似降智 1/3" / "通过 3/3", so the usage-log page grew one
    // client-filter entry per wording. The verdict lives in errorMessage now.
    expect(log.clientAppName).toBe('糖果题检测');
    expect(log.clientAppName).not.toContain('降智');
    expect(log.errorMessage).toContain('疑似降智');
  });

  it('logs an unreachable channel as a failed probe row', async () => {
    const { channel } = await seedChannel();
    dispatchRuntimeRequestMock.mockImplementation(async () => new Response(
      JSON.stringify({ error: { message: 'boom' } }),
      { status: 502, headers: { 'content-type': 'application/json' } },
    ));

    await service.runChannelCandyProbe({ channelId: channel.id });

    const log = (await db.select().from(schema.proxyLogs).all())[0];
    expect(log.status).toBe('failed');
    expect(log.httpStatus).toBe(502);
    expect(log.clientAppName).toBe('糖果题检测');
    expect(log.errorMessage).toContain('未完成');
  });

  it('stamps the usage-log row with a timestamp', async () => {
    const { channel } = await seedChannel();
    dispatchRuntimeRequestMock.mockImplementation(async () => new Response(
      sseChatText(WRONG_ANSWER),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ));

    await service.runChannelCandyProbe({ channelId: channel.id });

    const log = (await db.select().from(schema.proxyLogs).all())[0];
    // An explicit NULL used to suppress the column default, which made the row invisible to
    // every time-ordered view and to the retention sweep.
    expect(log.createdAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('records both token sides when the upstream reports usage', async () => {
    const { channel } = await seedChannel();
    dispatchRuntimeRequestMock.mockImplementation(async () => new Response(
      [
        `data: ${JSON.stringify({ model: 'm', choices: [{ delta: { content: '答案：20' } }] })}`,
        '',
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 } })}`,
        '',
        'data: [DONE]',
        '',
      ].join('\n'),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ));

    // A run is one request: the usage of that request is the run's usage.
    await service.runChannelCandyProbe({ channelId: channel.id, random: () => 0 });

    const log = (await db.select().from(schema.proxyLogs).all())[0];
    expect(log.promptTokens).toBe(12);
    expect(log.completionTokens).toBe(5);
    expect(log.totalTokens).toBe(17);
  });

  it('derives the total from two reported sides, which is what Anthropic sends', async () => {
    const { channel } = await seedChannel();
    // Anthropic reports input_tokens / output_tokens and no total; without deriving it the
    // claude path logged 12/5/0 while both halves were known.
    dispatchRuntimeRequestMock.mockImplementation(async () => new Response(
      [
        `data: ${JSON.stringify({ type: 'message_start', message: { model: 'claude-opus-5', usage: { input_tokens: 12, output_tokens: 1 } } })}`,
        '',
        `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: '答案：20' } })}`,
        '',
        `data: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: 5 } })}`,
        '',
      ].join('\n'),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ));

    await service.runChannelCandyProbe({ channelId: channel.id, random: () => 0 });

    const log = (await db.select().from(schema.proxyLogs).all())[0];
    expect(log.promptTokens).toBe(12);
    expect(log.completionTokens).toBe(5);
    expect(log.totalTokens).toBe(17);
  });

  it('leaves unknown token counts blank instead of fabricating a total', async () => {
    const { channel } = await seedChannel();
    dispatchRuntimeRequestMock.mockImplementation(async () => new Response(
      [
        `data: ${JSON.stringify({ model: 'm', choices: [{ delta: { content: '答案：20' } }] })}`,
        '',
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { output_tokens: 5 } })}`,
        '',
      ].join('\n'),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ));

    await service.runChannelCandyProbe({ channelId: channel.id, random: () => 0 });

    const log = (await db.select().from(schema.proxyLogs).all())[0];
    // `total = 0 + output` would have claimed 5 total tokens while the prompt was invisible.
    expect(log.completionTokens).toBe(5);
    expect(log.promptTokens).toBeNull();
    expect(log.totalTokens).toBeNull();
  });

  it('writes a debug trace tagged as a candy probe when capture is enabled', async () => {
    const { channel } = await seedChannel();
    const configModule = await import('../config.js');
    const previousEnabled = configModule.config.proxyDebugTraceEnabled;
    configModule.config.proxyDebugTraceEnabled = true;
    try {
      dispatchRuntimeRequestMock.mockImplementation(async () => new Response(
        sseChatText(WRONG_ANSWER),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      ));
      await service.runChannelCandyProbe({ channelId: channel.id });
    } finally {
      configModule.config.proxyDebugTraceEnabled = previousEnabled;
    }

    const traces = await db.select().from(schema.proxyDebugTraces).all();
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({
      clientKind: service.CANDY_PROBE_CLIENT_FAMILY,
      selectedChannelId: channel.id,
      requestedModel: 'claude-sonnet-4-5',
      finalStatus: 'success',
    });

    const attempts = await db.select().from(schema.proxyDebugAttempts).all();
    expect(attempts.length).toBeGreaterThan(0);
    expect(attempts[0].traceId).toBe(traces[0].id);
    expect(attempts[0].endpoint).toBe('chat');
  });

  it('marks the debug trace failed when the upstream answered with an error status', async () => {
    const { channel } = await seedChannel();
    const configModule = await import('../config.js');
    const previousEnabled = configModule.config.proxyDebugTraceEnabled;
    configModule.config.proxyDebugTraceEnabled = true;
    try {
      // A 502 WITH a body: `httpStatus != null` used to mark this trace success.
      dispatchRuntimeRequestMock.mockImplementation(async () => new Response(
        JSON.stringify({ error: { message: 'boom' } }),
        { status: 502, headers: { 'content-type': 'application/json' } },
      ));
      await service.runChannelCandyProbe({ channelId: channel.id });
    } finally {
      configModule.config.proxyDebugTraceEnabled = previousEnabled;
    }

    const traces = await db.select().from(schema.proxyDebugTraces).all();
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({
      finalStatus: 'failed',
      finalHttpStatus: 502,
    });
  });

  it('writes no debug trace while capture is disabled', async () => {
    const { channel } = await seedChannel();
    dispatchRuntimeRequestMock.mockImplementation(async () => new Response(
      sseChatText(WRONG_ANSWER),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ));

    await service.runChannelCandyProbe({ channelId: channel.id });

    expect(await db.select().from(schema.proxyDebugTraces).all()).toHaveLength(0);
  });

  it('never lets a usage-log failure break the verdict', async () => {
    const { channel } = await seedChannel();
    dispatchRuntimeRequestMock.mockImplementation(async () => new Response(
      sseChatText(WRONG_ANSWER),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ));
    // The audit trail is best-effort: a broken log writer must not cost the verdict.
    insertProxyLogMock.mockRejectedValue(new Error('logging is down'));

    const result = await service.runChannelCandyProbe({ channelId: channel.id });

    expect(result.verdict).toBe('fail');
    expect(service.getCandyProbeResultForChannel(channel.id)?.verdict).toBe('fail');
  });
});

describe('candy probe concurrency', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';
  let seedCounter = 0;
  let service: typeof import('./candyProbeService.js');
  let store: typeof import('./candyProbe/resultStore.js');

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-candy-concurrency-'));
    process.env.DATA_DIR = dataDir;
    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    db = dbModule.db;
    schema = dbModule.schema;
    service = await import('./candyProbeService.js');
    store = await import('./candyProbe/resultStore.js');
  });

  beforeEach(async () => {
    store.resetCandyProbeStoreForTests();
    service.resetCandyProbeConcurrencyForTests();
    resolveUpstreamEndpointCandidatesMock.mockReset().mockResolvedValue(['chat']);
    dispatchRuntimeRequestMock.mockReset();
    resolveChannelProxyUrlMock.mockReset().mockReturnValue(null);
    withSiteRecordProxyRequestInitMock.mockReset().mockImplementation(async (_site: unknown, init: unknown) => init);
    getOauthInfoFromAccountMock.mockReset().mockReturnValue(null);
    buildOauthProviderHeadersMock.mockReset().mockReturnValue({});
    insertProxyLogMock.mockReset().mockImplementation(async () => undefined);

    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    // Pool endpoints redirect every probe the site runs, so a row leaked from one test
    // would silently change which base URL the next test's probe targets.
    await db.delete(schema.siteApiEndpoints).run();
    await db.delete(schema.sites).run();
    await db.delete(schema.settings).run();
    await db.delete(schema.proxyLogs).run();
  });

  afterAll(() => {
    store.resetCandyProbeStoreForTests();
    service.resetCandyProbeConcurrencyForTests();
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // Windows keeps the SQLite file handle open; a failed cleanup must not fail the run.
    }
  });

  async function seedChannelFor(modelName: string) {
    return seedProbeChannelFixture({ db, schema }, () => ++seedCounter, { sourceModel: modelName });
  }

  it('shares one upstream request between callers for the same channel and parameters', async () => {
    const { channel } = await seedChannelFor('claude-sonnet-4-5');
    let resolveUpstream: ((value: Response) => void) | null = null;
    dispatchRuntimeRequestMock.mockImplementation(() => new Promise<Response>((resolve) => {
      resolveUpstream = resolve;
    }));

    // This test is about single-flight: both calls must cost exactly one upstream request.
    const first = service.runChannelCandyProbe({ channelId: channel.id, random: () => 0 });
    const second = service.runChannelCandyProbe({ channelId: channel.id, random: () => 0 });

    // Let both calls reach the single-flight map before the upstream is released.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(dispatchRuntimeRequestMock).toHaveBeenCalledTimes(1);
    expect(resolveUpstream).not.toBeNull();
    resolveUpstream!(new Response(sseChatText('1: 9.9'), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }));

    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(dispatchRuntimeRequestMock).toHaveBeenCalledTimes(1);
  });

  it('does not collapse two different fingerprints into one run', async () => {
    const { channel } = await seedChannelFor('claude-sonnet-4-5');
    dispatchRuntimeRequestMock.mockImplementation(async () => new Response(
      sseChatText('1: 9.9'),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ));

    const [claude, codex] = await Promise.all([
      service.runChannelCandyProbe({ channelId: channel.id, fingerprint: 'claude_code', random: () => 0 }),
      service.runChannelCandyProbe({ channelId: channel.id, fingerprint: 'codex', random: () => 0 }),
    ]);

    expect(claude.fingerprint).toBe('claude_code');
    expect(codex.fingerprint).toBe('codex');
    expect(dispatchRuntimeRequestMock).toHaveBeenCalledTimes(2);
  });

  it('reports the channel as in flight only while a run is going', async () => {
    const { channel } = await seedChannelFor('claude-sonnet-4-5');
    expect(service.isCandyProbeInFlight(channel.id)).toBe(false);
    let resolveUpstream: ((value: Response) => void) | null = null;
    dispatchRuntimeRequestMock.mockImplementation(() => new Promise<Response>((resolve) => {
      resolveUpstream = resolve;
    }));

    const run = service.runChannelCandyProbe({ channelId: channel.id, random: () => 0 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    // The schedule skips channels whose probe is in flight; this is the check it uses.
    expect(service.isCandyProbeInFlight(channel.id)).toBe(true);

    resolveUpstream!(new Response(sseChatText(CORRECT_ANSWER), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }));
    await run;
    expect(service.isCandyProbeInFlight(channel.id)).toBe(false);
  });

  it('caps how many probes hit upstream at once', async () => {
    const channels = [];
    for (let index = 0; index < service.CANDY_PROBE_MAX_CONCURRENT + 3; index += 1) {
      const seeded = await seedChannelFor(`claude-sonnet-4-5-${index}`);
      channels.push(seeded.channel);
    }

    let inFlight = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    dispatchRuntimeRequestMock.mockImplementation(() => new Promise<Response>((resolve) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      releases.push(() => {
        inFlight -= 1;
        resolve(new Response(sseChatText('1: 9.9'), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }));
      });
    }));

    const runs = channels.map((channel) => service.runChannelCandyProbe({
      channelId: channel.id,
      random: () => 0,
    }));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(peak).toBeLessThanOrEqual(service.CANDY_PROBE_MAX_CONCURRENT);

    // Drain: release whatever is running until every probe has finished.
    const drain = (async () => {
      while (releases.length > 0 || inFlight > 0) {
        const release = releases.shift();
        if (release) release();
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    })();
    await Promise.all([Promise.all(runs), drain]);
    expect(peak).toBeLessThanOrEqual(service.CANDY_PROBE_MAX_CONCURRENT);
    expect(dispatchRuntimeRequestMock).toHaveBeenCalledTimes(channels.length);
  });

  it('bounds the wait for a probe slot by the run deadline', async () => {
    const channels = [];
    for (let index = 0; index < service.CANDY_PROBE_MAX_CONCURRENT + 1; index += 1) {
      const seeded = await seedChannelFor(`claude-sonnet-4-5-slot-${index}`);
      channels.push(seeded.channel);
    }
    // Every slot is held by an upstream that never answers until released.
    const releases: Array<() => void> = [];
    dispatchRuntimeRequestMock.mockImplementation(() => new Promise<Response>((resolve) => {
      releases.push(() => resolve(new Response(sseChatText(CORRECT_ANSWER), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })));
    }));

    const holders = channels.slice(0, service.CANDY_PROBE_MAX_CONCURRENT).map((channel) => (
      service.runChannelCandyProbe({ channelId: channel.id, random: () => 0, timeoutMs: 60_000 })
    ));
    await new Promise((resolve) => setTimeout(resolve, 40));

    // The extra run queues for a slot; its own short deadline must end the wait.
    const startedAt = Date.now();
    const queued = await service.runChannelCandyProbe({
      channelId: channels[service.CANDY_PROBE_MAX_CONCURRENT]!.id,
      random: () => 0,
      timeoutMs: 1_000,
    });
    expect(queued.verdict).toBe('inconclusive');
    expect(queued.reason).toContain('探测超时');
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(dispatchRuntimeRequestMock).toHaveBeenCalledTimes(service.CANDY_PROBE_MAX_CONCURRENT);

    for (const release of releases.splice(0)) release();
    await Promise.all(holders);
  });

  it('does not let a scheduled run answer a manual click for the same channel', async () => {
    const { channel } = await seedChannelFor('claude-sonnet-4-5');
    dispatchRuntimeRequestMock.mockImplementation(async () => new Response(
      sseChatText(CORRECT_ANSWER),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ));

    const [scheduled, manual] = await Promise.all([
      service.runChannelCandyProbe({ channelId: channel.id, random: () => 0, trigger: 'schedule' }),
      service.runChannelCandyProbe({ channelId: channel.id, random: () => 0 }),
    ]);

    expect(scheduled.trigger).toBe('schedule');
    expect(manual.trigger).toBe('manual');
    expect(dispatchRuntimeRequestMock).toHaveBeenCalledTimes(2);
  });
});

describe('candy probe timeout resolution', () => {
  let serviceModule: typeof import('./candyProbeService.js');
  let configModule: typeof import('../config.js');

  beforeAll(async () => {
    serviceModule = await import('./candyProbeService.js');
    configModule = await import('../config.js');
  });

  afterEach(() => {
    configModule.config.proxyFirstByteTimeoutSec = 0;
  });

  it('raises a small streaming budget to the probe floor', () => {
    // The setting is a first-byte budget; a probe waits for a whole completion, so a 7s
    // first-byte timeout would cut reasoning models off mid-answer and read as "未完成".
    configModule.config.proxyFirstByteTimeoutSec = 7;
    expect(serviceModule.resolveCandyProbeTimeoutMs()).toBe(serviceModule.CANDY_PROBE_TIMEOUT_FLOOR_MS);
  });

  it('honours a streaming budget above the floor', () => {
    configModule.config.proxyFirstByteTimeoutSec = 180;
    expect(serviceModule.resolveCandyProbeTimeoutMs()).toBe(180_000);
  });

  it('falls back to the floor when the operator disabled the budget', () => {
    configModule.config.proxyFirstByteTimeoutSec = 0;
    // There is no separate fallback constant any more: the settings budget is always at least
    // the floor, so a smaller built-in value could never be the answer.
    expect(serviceModule.resolveCandyProbeTimeoutMs()).toBe(
      serviceModule.CANDY_PROBE_TIMEOUT_FLOOR_MS,
    );
  });

  it('lets an explicit override win over settings, inside the clamp but without the floor', () => {
    configModule.config.proxyFirstByteTimeoutSec = 30;
    // An explicit value is the caller's own decision (tests rely on short ones).
    expect(serviceModule.resolveCandyProbeTimeoutMs(400)).toBe(1_000);
    expect(serviceModule.resolveCandyProbeTimeoutMs(120_000)).toBe(120_000);
    expect(serviceModule.resolveCandyProbeTimeoutMs(10 * 60_000)).toBe(serviceModule.CANDY_PROBE_MAX_TIMEOUT_MS);
  });

  it('labels each verdict for the usage log, and guards the degradation wording', () => {
    expect(serviceModule.buildCandyProbeLogNote({
      verdict: 'pass', reason: null, expectation: 'expected', trigger: 'manual',
    })).toBe('糖果题判定：通过');

    // Only a model that was expected to pass may be called degraded; anything else is a
    // plain wrong answer.
    expect(serviceModule.buildCandyProbeLogNote({
      verdict: 'fail', reason: '答案为 20', expectation: 'expected', trigger: 'manual',
    })).toBe('糖果题判定：疑似降智｜答案为 20');
    expect(serviceModule.buildCandyProbeLogNote({
      verdict: 'fail', reason: '答案为 20', expectation: 'reference-only', trigger: 'manual',
    })).toBe('糖果题判定：答错｜答案为 20');
    expect(serviceModule.buildCandyProbeLogNote({
      verdict: 'fail', reason: '答案为 20', expectation: 'unknown', trigger: 'manual',
    })).toBe('糖果题判定：答错｜答案为 20');

    expect(serviceModule.buildCandyProbeLogNote({
      verdict: 'inconclusive', reason: '上游返回 502', expectation: 'expected', trigger: 'manual',
    })).toBe('糖果题判定：未完成｜上游返回 502');

    // Scheduled rows carry the prefix so the usage log can tell the schedule's own traffic
    // from a click without growing the client filter one entry per source.
    expect(serviceModule.buildCandyProbeLogNote({
      verdict: 'pass', reason: null, expectation: 'expected', trigger: 'schedule',
    })).toBe('［巡检］糖果题判定：通过');
  });
});
