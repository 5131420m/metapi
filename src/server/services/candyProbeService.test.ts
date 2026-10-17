import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CANDY_QUESTIONS, type CandyQuestion } from './candyProbe/questionBank.js';

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

/** Read the question bundle back out of whichever body shape the fingerprint produced. */
function readPromptFromBody(body: Record<string, any> | undefined): string {
  const claudeText = body?.messages?.[0]?.content?.[0]?.text;
  if (typeof claudeText === 'string') return claudeText;
  const chatContent = body?.messages?.[0]?.content;
  if (typeof chatContent === 'string') return chatContent;
  const responsesText = body?.input?.[0]?.content?.[0]?.text;
  if (typeof responsesText === 'string') return responsesText;
  return '';
}

function extractQuestionsFromPrompt(prompt: string): CandyQuestion[] {
  const found: CandyQuestion[] = [];
  for (const line of prompt.split('\n')) {
    const match = line.match(/^(\d+)\.\s+(.*)$/);
    if (!match) continue;
    const question = CANDY_QUESTIONS.find((candidate) => candidate.prompt === match[2]);
    if (question) found.push(question);
  }
  return found;
}

function buildAnswerText(prompt: string, mode: 'correct' | 'wrong'): string {
  return extractQuestionsFromPrompt(prompt)
    .map((question, index) => `${index + 1}: ${mode === 'correct' ? question.expectedLabel : '0'}`)
    .join('\n');
}

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

  it('records a pass when the model answers the battery correctly', async () => {
    const { channel } = await seedChannel();
    dispatchRuntimeRequestMock.mockImplementation(async (input: {
      request: { body: Record<string, any> };
    }) => {
      const prompt = readPromptFromBody(input.request.body);
      return new Response(sseChatText(buildAnswerText(prompt, 'correct')), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });

    const result = await service.runChannelCandyProbe({ channelId: channel.id });

    expect(result.verdict).toBe('pass');
    expect(result.score).toBe(3);
    expect(result.total).toBe(3);
    expect(result.fingerprint).toBe('claude_code');
    expect(result.endpoint).toBe('chat');
    expect(result.actualModel).toBe('bench-model');
    expect(result.questions.every((question) => question.correct)).toBe(true);
  });

  it('records a fail when the model answers every question wrongly', async () => {
    const { channel } = await seedChannel();
    dispatchRuntimeRequestMock.mockImplementation(async (input: {
      request: { body: Record<string, any> };
    }) => {
      const prompt = readPromptFromBody(input.request.body);
      return new Response(sseChatText(buildAnswerText(prompt, 'wrong')), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });

    const result = await service.runChannelCandyProbe({ channelId: channel.id });

    expect(result.verdict).toBe('fail');
    expect(result.score).toBe(0);
    expect(result.reason).toContain('低于通过阈值');
  });

  it('never touches channel health: routing state stays clean after a failing verdict', async () => {
    const { channel } = await seedChannel();
    dispatchRuntimeRequestMock.mockResolvedValue(new Response(
      sseChatText('1: 0\n2: 0\n3: 0'),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ));

    const result = await service.runChannelCandyProbe({ channelId: channel.id });
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
    dispatchRuntimeRequestMock.mockResolvedValue(new Response(
      JSON.stringify({ error: { message: 'model not found' } }),
      { status: 404, headers: { 'content-type': 'application/json' } },
    ));

    const result = await service.runChannelCandyProbe({ channelId: channel.id });

    expect(result.verdict).toBe('inconclusive');
    expect(result.reason).toContain('404');
    expect(result.reason).toContain('model not found');
  });

  it('reports an empty completion as inconclusive, not as degradation', async () => {
    const { channel } = await seedChannel();
    dispatchRuntimeRequestMock.mockResolvedValue(new Response('', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }));

    const result = await service.runChannelCandyProbe({ channelId: channel.id });

    expect(result.verdict).toBe('inconclusive');
    expect(result.reason).toContain('未返回可判分内容');
  });

  it('does not hang when the upstream stalls mid-stream', async () => {
    const { channel } = await seedChannel();
    // Headers arrive, then the body never ends: the exact shape that used to hang the
    // probe forever because the abort timer was cleared before the body read.
    dispatchRuntimeRequestMock.mockResolvedValue(new Response(
      new ReadableStream<Uint8Array>({ start() { /* never enqueue, never close */ } }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ));

    const startedAt = Date.now();
    const result = await service.runChannelCandyProbe({ channelId: channel.id, timeoutMs: 400 });
    const elapsedMs = Date.now() - startedAt;

    expect(result.verdict).toBe('inconclusive');
    expect(result.reason).toContain('探测超时');
    expect(elapsedMs).toBeLessThan(5_000);
  });

  it('picks the Codex fingerprint for GPT models and the generic one for others', async () => {
    const { channel: gptChannel } = await seedChannel({ sourceModel: 'gpt-5.4' });
    dispatchRuntimeRequestMock.mockResolvedValue(new Response('', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }));
    const gptResult = await service.runChannelCandyProbe({ channelId: gptChannel.id });
    expect(gptResult.fingerprint).toBe('codex');

    const { channel: otherChannel } = await seedChannel({ sourceModel: 'deepseek-v3' });
    const otherResult = await service.runChannelCandyProbe({ channelId: otherChannel.id });
    expect(otherResult.fingerprint).toBe('generic_openai');
  });

  it('honours an explicit fingerprint override', async () => {
    const { channel } = await seedChannel({ sourceModel: 'deepseek-v3' });
    dispatchRuntimeRequestMock.mockResolvedValue(new Response('', {
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
      return new Response(sseChatText('1: 0\n2: 0\n3: 0'), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });

    const result = await service.runChannelCandyProbe({ channelId: channel.id });
    expect(result.verdict).toBe('fail');
    expect(result.endpoint).toBe('messages');
    expect(dispatchRuntimeRequestMock).toHaveBeenCalledTimes(1);
  });

  it('rejects an unknown channel with a 404-style error', async () => {
    await expect(service.runChannelCandyProbe({ channelId: 999 })).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('rejects a channel without a probeable model name', async () => {
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
    dispatchRuntimeRequestMock.mockImplementation(async (input: { request: { body: Record<string, any> } }) => (
      new Response(sseChatText(buildAnswerText(readPromptFromBody(input.request.body), 'correct')), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    ));

    await service.runChannelCandyProbe({ channelId: channel.id });
    const snapshots = service.getCandyProbeSnapshots([channel.id]);

    expect(snapshots[String(channel.id)]).toMatchObject({
      channelId: channel.id,
      verdict: 'pass',
      fresh: true,
    });
    // The list payload stays lean: per-question detail is fetched on demand.
    expect(snapshots[String(channel.id)]).not.toHaveProperty('questions');
  });

  it('writes one usage-log row per run, tagged as a candy probe and costing nothing', async () => {
    const { channel, account } = await seedChannel();
    dispatchRuntimeRequestMock.mockImplementation(async (input: { request: { body: Record<string, any> } }) => (
      new Response(sseChatText(buildAnswerText(readPromptFromBody(input.request.body), 'correct')), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    ));

    await service.runChannelCandyProbe({ channelId: channel.id });

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
    const { channel } = await seedChannel();
    dispatchRuntimeRequestMock.mockResolvedValue(new Response(
      sseChatText('1: 0\n2: 0\n3: 0'),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ));

    await service.runChannelCandyProbe({ channelId: channel.id });

    const log = (await db.select().from(schema.proxyLogs).all())[0];
    // The app name used to carry "疑似降智 1/3" / "通过 3/3", so the usage-log page grew one
    // client-filter entry per wording. The verdict lives in errorMessage now.
    expect(log.clientAppName).toBe('糖果题检测');
    expect(log.clientAppName).not.toContain('降智');
    expect(log.errorMessage).toContain('疑似降智');
  });

  it('logs an unreachable channel as a failed probe row', async () => {
    const { channel } = await seedChannel();
    dispatchRuntimeRequestMock.mockResolvedValue(new Response(
      JSON.stringify({ error: { message: 'boom' } }),
      { status: 502, headers: { 'content-type': 'application/json' } },
    ));

    await service.runChannelCandyProbe({ channelId: channel.id });

    const log = (await db.select().from(schema.proxyLogs).all())[0];
    expect(log.status).toBe('failed');
    expect(log.httpStatus).toBe(502);
    expect(log.clientAppName).toBe('糖果题检测');
    expect(log.errorMessage).toContain('不确定');
  });

  it('stamps the usage-log row with a timestamp', async () => {
    const { channel } = await seedChannel();
    dispatchRuntimeRequestMock.mockResolvedValue(new Response(
      sseChatText('1: 0\n2: 0\n3: 0'),
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
    dispatchRuntimeRequestMock.mockResolvedValue(new Response(
      [
        `data: ${JSON.stringify({ model: 'm', choices: [{ delta: { content: '1: 0\\n2: 0\\n3: 0' } }] })}`,
        '',
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 } })}`,
        '',
        'data: [DONE]',
        '',
      ].join('\n'),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ));

    await service.runChannelCandyProbe({ channelId: channel.id });

    const log = (await db.select().from(schema.proxyLogs).all())[0];
    expect(log.promptTokens).toBe(12);
    expect(log.completionTokens).toBe(5);
    expect(log.totalTokens).toBe(17);
  });

  it('leaves unknown token counts blank instead of fabricating a total', async () => {
    const { channel } = await seedChannel();
    dispatchRuntimeRequestMock.mockResolvedValue(new Response(
      [
        `data: ${JSON.stringify({ model: 'm', choices: [{ delta: { content: '1: 0\\n2: 0\\n3: 0' } }] })}`,
        '',
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { output_tokens: 5 } })}`,
        '',
      ].join('\n'),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ));

    await service.runChannelCandyProbe({ channelId: channel.id });

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
      dispatchRuntimeRequestMock.mockResolvedValue(new Response(
        sseChatText('1: 0\n2: 0\n3: 0'),
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

  it('writes no debug trace while capture is disabled', async () => {
    const { channel } = await seedChannel();
    dispatchRuntimeRequestMock.mockResolvedValue(new Response(
      sseChatText('1: 0\n2: 0\n3: 0'),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ));

    await service.runChannelCandyProbe({ channelId: channel.id });

    expect(await db.select().from(schema.proxyDebugTraces).all()).toHaveLength(0);
  });

  it('never lets a usage-log failure break the verdict', async () => {
    const { channel } = await seedChannel();
    dispatchRuntimeRequestMock.mockResolvedValue(new Response(
      sseChatText('1: 0\n2: 0\n3: 0'),
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

    const first = service.runChannelCandyProbe({ channelId: channel.id });
    const second = service.runChannelCandyProbe({ channelId: channel.id });

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
      service.runChannelCandyProbe({ channelId: channel.id, fingerprint: 'claude_code' }),
      service.runChannelCandyProbe({ channelId: channel.id, fingerprint: 'codex' }),
    ]);

    expect(claude.fingerprint).toBe('claude_code');
    expect(codex.fingerprint).toBe('codex');
    expect(dispatchRuntimeRequestMock).toHaveBeenCalledTimes(2);
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

    const runs = channels.map((channel) => service.runChannelCandyProbe({ channelId: channel.id }));
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
    // first-byte timeout would cut reasoning models off mid-answer and read as "不确定".
    configModule.config.proxyFirstByteTimeoutSec = 7;
    expect(serviceModule.resolveCandyProbeTimeoutMs()).toBe(serviceModule.CANDY_PROBE_TIMEOUT_FLOOR_MS);
  });

  it('honours a streaming budget above the floor', () => {
    configModule.config.proxyFirstByteTimeoutSec = 90;
    expect(serviceModule.resolveCandyProbeTimeoutMs()).toBe(90_000);
  });

  it('falls back to the built-in ceiling when the operator disabled the budget, still floored', () => {
    configModule.config.proxyFirstByteTimeoutSec = 0;
    expect(serviceModule.resolveCandyProbeTimeoutMs()).toBe(
      Math.max(serviceModule.CANDY_PROBE_TIMEOUT_MS, serviceModule.CANDY_PROBE_TIMEOUT_FLOOR_MS),
    );
  });

  it('lets an explicit override win over settings, inside the clamp but without the floor', () => {
    configModule.config.proxyFirstByteTimeoutSec = 30;
    // An explicit value is the caller's own decision (tests rely on short ones).
    expect(serviceModule.resolveCandyProbeTimeoutMs(400)).toBe(1_000);
    expect(serviceModule.resolveCandyProbeTimeoutMs(120_000)).toBe(120_000);
    expect(serviceModule.resolveCandyProbeTimeoutMs(10 * 60_000)).toBe(serviceModule.CANDY_PROBE_MAX_TIMEOUT_MS);
  });

  it('labels each verdict for the usage log', () => {
    expect(serviceModule.buildCandyProbeLogNote({ verdict: 'pass', score: 3, total: 3, reason: null }))
      .toBe('糖果题判定：通过 3/3');
    expect(serviceModule.buildCandyProbeLogNote({ verdict: 'fail', score: 1, total: 3, reason: '答对 1/3，低于通过阈值 2' }))
      .toContain('疑似降智 1/3');
    expect(serviceModule.buildCandyProbeLogNote({ verdict: 'inconclusive', score: 0, total: 3, reason: '探测超时' }))
      .toContain('不确定');
  });
});
