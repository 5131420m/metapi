import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

type DbModule = typeof import('../db/index.js');

const {
  resolveUpstreamEndpointCandidatesMock,
  dispatchRuntimeRequestMock,
  resolveChannelProxyUrlMock,
  withSiteRecordProxyRequestInitMock,
  getOauthInfoFromAccountMock,
  buildOauthProviderHeadersMock,
  getIdentityDetectorMock,
  analyzeMock,
} = vi.hoisted(() => ({
  resolveUpstreamEndpointCandidatesMock: vi.fn(),
  dispatchRuntimeRequestMock: vi.fn(),
  resolveChannelProxyUrlMock: vi.fn(),
  withSiteRecordProxyRequestInitMock: vi.fn(),
  getOauthInfoFromAccountMock: vi.fn(),
  buildOauthProviderHeadersMock: vi.fn(),
  getIdentityDetectorMock: vi.fn(),
  analyzeMock: vi.fn(),
}));

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

/**
 * Only the reference-bank LOAD is replaced (it would download ~4MB). Challenge generation,
 * request bodies and number parsing stay real, so the test exercises what is actually sent.
 */
vi.mock('./modelIdentityProbe/detector.js', async () => {
  const actual = await vi.importActual<typeof import('./modelIdentityProbe/detector.js')>('./modelIdentityProbe/detector.js');
  return {
    ...actual,
    getIdentityDetector: () => getIdentityDetectorMock(),
  };
});

/** A reply of `count` integers spread over 1–355, the way a model writes them. */
function numbersReply(count: number): string {
  return Array.from({ length: count }, (_, index) => ((index * 97) % 355) + 1).join(', ');
}

function sseChat(text: string, model = 'upstream-model', usage?: Record<string, number>): string {
  const chunks = [
    `data: ${JSON.stringify({ model, choices: [{ delta: { content: text }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ model, choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
  ];
  if (usage) chunks.push(`data: ${JSON.stringify({ model, choices: [], usage })}\n\n`);
  return `${chunks.join('')}data: [DONE]\n\n`;
}

function sseResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** The expected count of the challenge a dispatched request carries (parsed from its prompt). */
function requestedCount(input: { request?: { body?: Record<string, unknown> } }): number {
  const body = input.request?.body ?? {};
  const messages = (body.messages ?? body.input) as Array<{ content: unknown }> | undefined;
  const prompt = String(messages?.[0]?.content ?? '');
  const match = prompt.match(/\b(2\d\d|3[0-3]\d)\b/);
  return match ? Number(match[1]) : 300;
}

function scoredAnalysis(top: { model: string; family: string }, probability = 0.8) {
  return {
    decision: 'scored',
    prediction: top.model,
    prediction_name: top.model,
    family_prediction: top.family,
    family_prediction_name: top.family,
    results: [
      { model: top.model, display_name: top.model, family: top.family, family_name: top.family, score: 1, probability },
      { model: 'claude-opus-4.6', display_name: 'claude-opus-4.6', family: 'claude', family_name: 'Claude', score: 0.5, probability: 0.1 },
    ],
    ranking_score: 1,
    probability,
    probability_status: 'reference_calibrated',
    probability_scope: 'reference-bank',
    calibration: null,
    used_outputs: 3,
    diagnostics: [],
    sequence: { autocorrelation: 0.1, small_step_share: 0.1, model_like: true },
    method: 'test',
    model_version: { base_sha256: 'x' },
    evidence: { insufficient: false, label: '', reason: '', threshold: null, method: 'test' },
  };
}

describe('runChannelIdentityProbe', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';
  let seedCounter = 0;
  let service: typeof import('./modelIdentityProbeService.js');
  let store: typeof import('./modelIdentityProbe/resultStore.js');

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-identity-probe-'));
    process.env.DATA_DIR = dataDir;
    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    db = dbModule.db;
    schema = dbModule.schema;
    service = await import('./modelIdentityProbeService.js');
    store = await import('./modelIdentityProbe/resultStore.js');
  });

  beforeEach(async () => {
    store.resetIdentityProbeStoreForTests();
    service.resetIdentityProbeConcurrencyForTests();
    resolveUpstreamEndpointCandidatesMock.mockReset().mockResolvedValue(['chat']);
    dispatchRuntimeRequestMock.mockReset();
    resolveChannelProxyUrlMock.mockReset().mockReturnValue(null);
    withSiteRecordProxyRequestInitMock.mockReset().mockImplementation(async (_site: unknown, init: unknown) => init);
    getOauthInfoFromAccountMock.mockReset().mockReturnValue(null);
    buildOauthProviderHeadersMock.mockReset().mockReturnValue({});
    analyzeMock.mockReset().mockReturnValue(scoredAnalysis({ model: 'gemini-2.5-pro', family: 'gemini' }));
    getIdentityDetectorMock.mockReset().mockResolvedValue({ builtAt: 'bank-test', analyze: analyzeMock });

    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.siteApiEndpoints).run();
    await db.delete(schema.sites).run();
    await db.delete(schema.settings).run();
    await db.delete(schema.proxyLogs).run();
    await db.delete(schema.proxyDebugAttempts).run();
    await db.delete(schema.proxyDebugTraces).run();
  });

  afterAll(() => {
    store.resetIdentityProbeStoreForTests();
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows file lock */ }
    delete process.env.DATA_DIR;
  });

  async function seedChannel(input: { sourceModel?: string | null; withToken?: boolean; apiToken?: string } = {}) {
    const seedId = ++seedCounter;
    const site = await db.insert(schema.sites).values({
      name: `identity-site-${seedId}`,
      url: `https://identity-${seedId}.example.com`,
      platform: 'new-api',
      status: 'active',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'identity-user',
      accessToken: '',
      apiToken: input.apiToken ?? 'sk-identity',
      status: 'active',
    }).returning().get();
    const token = input.withToken === false ? null : await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'identity-token',
      token: 'token-identity',
      enabled: true,
      isDefault: false,
    }).returning().get();
    const sourceModel = input.sourceModel === undefined ? 'claude-opus-4-6' : input.sourceModel;
    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: `${sourceModel || 'x'}@${Math.random().toString(36).slice(2, 8)}`,
      enabled: true,
    }).returning().get();
    const channel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      tokenId: token?.id ?? null,
      sourceModel,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();
    return { site, account, token, route, channel };
  }

  function replyWithCounts() {
    dispatchRuntimeRequestMock.mockImplementation(async (input: { request?: { body?: Record<string, unknown> } }) => (
      sseResponse(sseChat(numbersReply(requestedCount(input)), 'upstream-model', { prompt_tokens: 100, completion_tokens: 900 }))
    ));
  }

  it('sends three challenges one after another and records a mismatch', async () => {
    const { channel } = await seedChannel();
    let inFlight = 0;
    let maxInFlight = 0;
    dispatchRuntimeRequestMock.mockImplementation(async (input: { request?: { body?: Record<string, unknown> } }) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return sseResponse(sseChat(numbersReply(requestedCount(input))));
    });

    const result = await service.runChannelIdentityProbe({ channelId: channel.id });

    expect(dispatchRuntimeRequestMock).toHaveBeenCalledTimes(3);
    expect(maxInFlight).toBe(1);
    expect(result.verdict).toBe('mismatch');
    expect(result.prediction?.model).toBe('gemini-2.5-pro');
    expect(result.claimedFamily).toBe('claude');
    expect(result.claimedRank).toBe(2);
    expect(result.samples).toHaveLength(3);
    expect(result.samples.every((sample) => sample.accepted)).toBe(true);
    expect(result.config.bankBuiltAt).toBe('bank-test');
    expect(result.requestFormat).toBe('claude');
    expect(result.endpoint).toBe('chat');
    expect(result.actualModel).toBe('upstream-model');
    // The detector got three outputs, each with its own expected count.
    const outputs = analyzeMock.mock.calls[0]![0] as Array<{ text: string; expected_count: number }>;
    expect(outputs).toHaveLength(3);
    expect(new Set(outputs.map((output) => output.expected_count)).size).toBe(3);
    expect(store.getIdentityProbeResultForChannel(channel.id)?.verdict).toBe('mismatch');
  });

  it('sends the SDK body under a neutral SDK identity, not a Claude Code identity', async () => {
    const { channel } = await seedChannel();
    replyWithCounts();
    await service.runChannelIdentityProbe({ channelId: channel.id });

    const sent = dispatchRuntimeRequestMock.mock.calls[0]![0] as {
      request: { headers: Record<string, string>; body: Record<string, unknown> };
    };
    const body = JSON.stringify(sent.request.body);
    expect(body).not.toContain('You are Claude Code');
    expect(body).not.toContain('metadata');
    const headerKeys = Object.keys(sent.request.headers).map((key) => key.toLowerCase());
    expect(headerKeys).not.toContain('x-app');
    expect(headerKeys).not.toContain('originator');
  });

  it('records model_match when the claimed model is on top', async () => {
    const { channel } = await seedChannel({ sourceModel: 'claude-opus-4-6' });
    analyzeMock.mockReturnValue(scoredAnalysis({ model: 'claude-opus-4.6', family: 'claude' }, 0.5));
    replyWithCounts();
    const result = await service.runChannelIdentityProbe({ channelId: channel.id });
    expect(result.verdict).toBe('model_match');
    expect(result.claimedRank).toBe(1);
    // The fixture ranks claude-opus-4.6 again in second place (0.1): the line sums both.
    expect(result.claimedProbability).toBeCloseTo(0.6, 5);
    const row = await db.select().from(schema.proxyLogs).where(eq(schema.proxyLogs.channelId, channel.id)).get();
    expect(row?.errorMessage).toBe('模型指纹判定：型号一致｜最像 claude-opus-4.6 · 50%');
  });

  it('records version_mismatch when another model of the family is on top', async () => {
    const { channel } = await seedChannel({ sourceModel: 'claude-opus-4-6' });
    analyzeMock.mockReturnValue(scoredAnalysis({ model: 'claude-sonnet-5', family: 'claude' }, 0.9));
    replyWithCounts();
    const result = await service.runChannelIdentityProbe({ channelId: channel.id });
    expect(result.verdict).toBe('version_mismatch');
    expect(result.claimedRank).toBe(2);
    const row = await db.select().from(schema.proxyLogs).where(eq(schema.proxyLogs.channelId, channel.id)).get();
    expect(row?.errorMessage).toContain('模型指纹判定：疑似换版本');
  });

  it('never calls the upstream when the reference bank cannot be loaded', async () => {
    const { channel } = await seedChannel();
    getIdentityDetectorMock.mockRejectedValue(new Error('lmfpd: cannot download reference data'));
    const result = await service.runChannelIdentityProbe({ channelId: channel.id });
    expect(result.verdict).toBe('inconclusive');
    expect(result.reason).toContain('参考库不可用');
    expect(dispatchRuntimeRequestMock).not.toHaveBeenCalled();
  });

  it('keeps going after a failed challenge and scores the rest', async () => {
    const { channel } = await seedChannel();
    let call = 0;
    dispatchRuntimeRequestMock.mockImplementation(async (input: { request?: { body?: Record<string, unknown> } }) => {
      call += 1;
      if (call === 2) return new Response('quota exceeded', { status: 429 });
      return sseResponse(sseChat(numbersReply(requestedCount(input))));
    });

    const result = await service.runChannelIdentityProbe({ channelId: channel.id });

    expect(result.samples.map((sample) => sample.state)).toEqual(['complete', 'failed', 'complete']);
    expect(result.samples[1]?.error).toBeTruthy();
    const outputs = analyzeMock.mock.calls[0]![0] as Array<{ text: string }>;
    expect(outputs[1]?.text).toBe('');
  });

  it('rejects a reply with too few integers and is inconclusive when none is usable', async () => {
    const { channel } = await seedChannel();
    dispatchRuntimeRequestMock.mockImplementation(async () => sseResponse(sseChat('我无法完成这个任务。')));
    const result = await service.runChannelIdentityProbe({ channelId: channel.id });
    expect(result.verdict).toBe('inconclusive');
    expect(result.samples.every((sample) => !sample.accepted)).toBe(true);
    expect(result.samples[0]?.error).toContain('整数个数不足');
    expect(analyzeMock).not.toHaveBeenCalled();
  });

  it('writes exactly one usage-log row, tagged and free, with summed tokens', async () => {
    const { channel } = await seedChannel();
    replyWithCounts();
    await service.runChannelIdentityProbe({ channelId: channel.id });

    const rows = await db.select().from(schema.proxyLogs).where(eq(schema.proxyLogs.channelId, channel.id)).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.clientFamily).toBe('model_identity_probe');
    expect(rows[0]?.clientAppName).toBe('模型指纹检测');
    expect(rows[0]?.estimatedCost).toBe(0);
    expect(rows[0]?.promptTokens).toBe(300);
    expect(rows[0]?.completionTokens).toBe(2700);
    expect(rows[0]?.errorMessage).toContain('模型指纹判定：疑似换皮');
  });

  it('leaves the token columns blank unless every challenge reported usage', async () => {
    const { channel } = await seedChannel();
    let call = 0;
    dispatchRuntimeRequestMock.mockImplementation(async (input: { request?: { body?: Record<string, unknown> } }) => {
      call += 1;
      const usage = call === 1 ? { prompt_tokens: 100, completion_tokens: 900 } : undefined;
      return sseResponse(sseChat(numbersReply(requestedCount(input)), 'upstream-model', usage));
    });
    await service.runChannelIdentityProbe({ channelId: channel.id });
    const row = await db.select().from(schema.proxyLogs).where(eq(schema.proxyLogs.channelId, channel.id)).get();
    expect(row?.promptTokens).toBeNull();
    expect(row?.totalTokens).toBeNull();
  });

  it('is single-flight per channel', async () => {
    const { channel } = await seedChannel();
    replyWithCounts();
    const [first, second] = await Promise.all([
      service.runChannelIdentityProbe({ channelId: channel.id }),
      service.runChannelIdentityProbe({ channelId: channel.id }),
    ]);
    expect(first).toBe(second);
    expect(dispatchRuntimeRequestMock).toHaveBeenCalledTimes(3);
  });

  it('never passes the forwarding proxy as a base URL', async () => {
    const { channel } = await seedChannel();
    resolveChannelProxyUrlMock.mockReturnValue('http://forward-proxy.local:8080');
    // The real dispatcher calls buildInit to make the fetch init; the mock must do the same.
    dispatchRuntimeRequestMock.mockImplementation(async (input: {
      targetUrl: string;
      request: { headers: Record<string, string>; body: Record<string, unknown> };
      buildInit: (url: string, request: unknown) => Promise<unknown>;
    }) => {
      await input.buildInit(input.targetUrl, input.request);
      return sseResponse(sseChat(numbersReply(requestedCount(input))));
    });
    await service.runChannelIdentityProbe({ channelId: channel.id });
    for (const [input] of dispatchRuntimeRequestMock.mock.calls as Array<[{ targetUrl: string }]>) {
      expect(input.targetUrl).not.toContain('forward-proxy.local');
    }
    // The proxy still reaches the request through buildInit.
    expect(withSiteRecordProxyRequestInitMock.mock.calls.some((call) => call[2] === 'http://forward-proxy.local:8080')).toBe(true);
  });

  it('picks the request format from the model family', () => {
    expect(service.resolveIdentityRequestFormat('claude-sonnet-4-5')).toBe('claude');
    expect(service.resolveIdentityRequestFormat('gpt-5.4')).toBe('responses');
    expect(service.resolveIdentityRequestFormat('deepseek-chat')).toBe('openai');
  });

  it('rejects channels that cannot be probed', async () => {
    await expect(service.runChannelIdentityProbe({ channelId: 999_999 })).rejects.toMatchObject({ statusCode: 404 });
    const embedding = await seedChannel({ sourceModel: 'text-embedding-3-large' });
    await expect(service.runChannelIdentityProbe({ channelId: embedding.channel.id })).rejects.toMatchObject({ statusCode: 400 });
    const noCredential = await seedChannel({ withToken: false, apiToken: '' });
    await expect(service.runChannelIdentityProbe({ channelId: noCredential.channel.id })).rejects.toMatchObject({ statusCode: 400 });
  });
});
