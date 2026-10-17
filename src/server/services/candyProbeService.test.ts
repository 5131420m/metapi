import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
} = vi.hoisted(() => ({
  resolveUpstreamEndpointCandidatesMock: vi.fn(),
  dispatchRuntimeRequestMock: vi.fn(),
  resolveChannelProxyUrlMock: vi.fn(),
  withSiteRecordProxyRequestInitMock: vi.fn(),
  getOauthInfoFromAccountMock: vi.fn(),
  buildOauthProviderHeadersMock: vi.fn(),
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
    resolveUpstreamEndpointCandidatesMock.mockReset().mockResolvedValue(['chat']);
    dispatchRuntimeRequestMock.mockReset();
    resolveChannelProxyUrlMock.mockReset().mockReturnValue(null);
    withSiteRecordProxyRequestInitMock.mockReset().mockImplementation(async (_site: unknown, init: unknown) => init);
    getOauthInfoFromAccountMock.mockReset().mockReturnValue(null);
    buildOauthProviderHeadersMock.mockReset().mockReturnValue({});

    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
    await db.delete(schema.settings).run();
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
    const seedId = ++seedCounter;
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
});
