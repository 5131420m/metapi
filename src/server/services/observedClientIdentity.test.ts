import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { eq } from 'drizzle-orm';
import {
  CLAUDE_CODE_FIXTURE_HEADERS,
  CODEX_RESPONSES_FIXTURE_HEADERS,
} from '../test-fixtures/observedClientIdentityFixtures.js';
import {
  BUILTIN_CLAUDE_CODE_USER_AGENT,
  BUILTIN_CODEX_USER_AGENT,
} from './candyProbe/fingerprints.js';

type DbModule = typeof import('../db/index.js');
type StoreModule = typeof import('./observedClientIdentity.js');

describe('observed client identity store', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let store: StoreModule;
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-observed-identity-'));
    process.env.DATA_DIR = dataDir;
    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    db = dbModule.db;
    schema = dbModule.schema;
    store = await import('./observedClientIdentity.js');
  });

  beforeEach(async () => {
    store.resetObservedClientIdentityStoreForTests();
    await db.delete(schema.settings).run();
  });

  afterAll(() => {
    store.resetObservedClientIdentityStoreForTests();
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // Windows keeps the SQLite handle open.
    }
    delete process.env.DATA_DIR;
  });

  it('keeps identity headers and session header names, never credentials or session values', () => {
    const entry = store.recordObservedClientIdentity({
      clientKind: 'claude_code',
      downstreamFormat: 'claude',
      headers: { ...CLAUDE_CODE_FIXTURE_HEADERS, 'x-metapi-tester-request': '1' },
      body: { model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'secret prompt' }], stream: true },
    })!;

    expect(entry.headers).toEqual({
      'anthropic-beta': CLAUDE_CODE_FIXTURE_HEADERS['anthropic-beta'],
      'anthropic-dangerous-direct-browser-access': 'true',
      'anthropic-version': '2023-06-01',
      'user-agent': 'claude-cli/2.1.151 (external, cli)',
      'x-app': 'cli',
      'x-stainless-arch': 'arm64',
      'x-stainless-lang': 'js',
      'x-stainless-os': 'MacOS',
      'x-stainless-package-version': '0.112.1',
      'x-stainless-retry-count': '0',
      'x-stainless-runtime': 'node',
      'x-stainless-runtime-version': 'v26.3.0',
      'x-stainless-timeout': '600',
    });
    expect(entry.sessionHeaderNames).toEqual(['x-claude-code-session-id']);
    expect(entry.bodyTraits).toEqual({ stream: true, hasTopLevelSystem: false, hasMetadataUserId: false });
    const serialized = JSON.stringify(store.listObservedClientIdentities());
    expect(serialized).not.toContain('sk-secret');
    expect(serialized).not.toContain('3ffd96b8');
    expect(serialized).not.toContain('secret prompt');
    expect(serialized).not.toContain('192.168.123.2');
  });

  it('records responses body traits without content', () => {
    const entry = store.recordObservedClientIdentity({
      clientKind: 'codex',
      downstreamFormat: 'responses',
      headers: CODEX_RESPONSES_FIXTURE_HEADERS,
      body: {
        model: 'gpt-5.6-luna',
        instructions: '',
        stream: true,
        reasoning: { effort: 'medium' },
        parallel_tool_calls: true,
        include: ['reasoning.encrypted_content'],
        store: false,
        prompt_cache_key: '764219db-0af7-50c5-a85a-c45508de6d1b',
        input: [{ type: 'message', role: 'user', content: 'hello' }],
      },
    })!;
    expect(entry.headers).toEqual({
      originator: 'codex_cli_rs',
      'user-agent': CODEX_RESPONSES_FIXTURE_HEADERS['user-agent'],
    });
    expect(entry.sessionHeaderNames).toEqual(['session-id']);
    expect(entry.bodyTraits).toEqual({
      stream: true,
      reasoningEffort: 'medium',
      include: ['reasoning.encrypted_content'],
      store: false,
      hasMaxOutputTokens: false,
      hasPromptCacheKey: true,
      parallelToolCalls: true,
    });
  });

  it('ignores requests without a user agent', () => {
    expect(store.recordObservedClientIdentity({
      clientKind: 'codex',
      downstreamFormat: 'openai',
      headers: { originator: 'codex_cli_rs' },
    })).toBeNull();
    expect(store.listObservedClientIdentities()).toEqual([]);
  });

  it('never learns a third-party OpenAI SDK that the proxy classifies as codex', async () => {
    // Real headers of the official OpenAI Node SDK. The proxy's Codex detection is a routing
    // heuristic that matches any `x-stainless-*` header, so this request IS `codex` to it.
    const openAiSdkHeaders = {
      'user-agent': 'OpenAI/JS 4.104.0',
      'x-stainless-lang': 'js',
      'x-stainless-package-version': '4.104.0',
      'x-stainless-os': 'MacOS',
      'x-stainless-runtime': 'node',
      'openai-beta': 'responses=experimental',
    };
    const { detectDownstreamClientContext } = await import('../proxy-core/downstreamClientContext.js');
    for (const downstreamPath of ['/v1/chat/completions', '/v1/responses']) {
      expect(detectDownstreamClientContext({ downstreamPath, headers: openAiSdkHeaders }).clientKind).toBe('codex');
    }

    for (const downstreamFormat of ['openai', 'responses'] as const) {
      expect(store.recordObservedClientIdentity({ clientKind: 'codex', downstreamFormat, headers: openAiSdkHeaders }))
        .toBeNull();
    }
    // An originator alone does not make a client official either.
    expect(store.recordObservedClientIdentity({
      clientKind: 'codex',
      downstreamFormat: 'openai',
      headers: { 'user-agent': 'python-httpx/0.28.1', originator: 'codex_cli_rs' },
    })).toBeNull();
    expect(store.listObservedClientIdentities()).toEqual([]);

    const chat = store.resolveClientIdentityProfile({ downstreamFormat: 'openai', sessionSeed: 's' });
    expect(chat.source).toBe('builtin');
    expect(chat.userAgent).toBe(BUILTIN_CODEX_USER_AGENT);
  });

  it('never learns a non-Claude-Code client on the Claude surface', () => {
    expect(store.recordObservedClientIdentity({
      clientKind: 'claude_code',
      downstreamFormat: 'claude',
      headers: { ...CLAUDE_CODE_FIXTURE_HEADERS, 'user-agent': 'Anthropic/JS 0.112.1' },
    })).toBeNull();
    expect(store.listObservedClientIdentities()).toEqual([]);
  });

  it('learns every official Codex client app', () => {
    for (const userAgent of [
      'codex_cli_rs/0.114.0 (Mac OS 14.2.0; x86_64) vscode/1.111.0',
      'codex_vscode/0.114.0',
      'codex_exec/0.114.0',
    ]) {
      expect(store.recordObservedClientIdentity({
        clientKind: 'codex',
        downstreamFormat: 'responses',
        headers: { 'user-agent': userAgent },
      }), userAgent).not.toBeNull();
    }
  });

  it('keeps the latest variant first, deduplicates by user agent and caps the variants', () => {
    for (let index = 0; index < 7; index += 1) {
      store.recordObservedClientIdentity({
        clientKind: 'codex',
        downstreamFormat: 'openai',
        headers: { 'user-agent': `codex_cli_rs/0.1${index}.0`, originator: 'codex_cli_rs' },
        nowMs: 1_000 + index,
      });
    }
    store.recordObservedClientIdentity({
      clientKind: 'codex',
      downstreamFormat: 'openai',
      headers: { 'user-agent': 'codex_cli_rs/0.15.0', originator: 'codex_cli_rs' },
      nowMs: 5_000,
    });
    const variants = store.listObservedClientIdentities();
    expect(variants).toHaveLength(5);
    expect(variants[0]!.headers['user-agent']).toBe('codex_cli_rs/0.15.0');
    expect(variants[0]!.count).toBe(2);
    expect(store.getObservedClientIdentity('codex', 'openai', 'codex_cli_rs/0.14.0')?.count).toBe(1);
  });

  it('resolves an observed profile with seeded session ids', () => {
    store.recordObservedClientIdentity({
      clientKind: 'claude_code',
      downstreamFormat: 'claude',
      headers: CLAUDE_CODE_FIXTURE_HEADERS,
      body: { stream: true },
    });
    const profile = store.resolveClientIdentityProfile({ downstreamFormat: 'claude', sessionSeed: 'candy:1:2' });
    expect(profile.source).toBe('observed');
    expect(profile.clientKind).toBe('claude_code');
    expect(profile.userAgent).toBe('claude-cli/2.1.151 (external, cli)');
    expect(profile.providerHeaders).toEqual({});
    expect(profile.downstreamHeaders['x-claude-code-session-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(profile.downstreamHeaders['x-claude-code-session-id']).not.toBe(CLAUDE_CODE_FIXTURE_HEADERS['x-claude-code-session-id']);
    expect(profile.sessionId).toBe(profile.downstreamHeaders['x-claude-code-session-id']);
    // Stable per seed, distinct across seeds.
    expect(store.resolveClientIdentityProfile({ downstreamFormat: 'claude', sessionSeed: 'candy:1:2' }).sessionId)
      .toBe(profile.sessionId);
    expect(store.resolveClientIdentityProfile({ downstreamFormat: 'claude', sessionSeed: 'identity:1:2' }).sessionId)
      .not.toBe(profile.sessionId);
  });

  it('falls back to the built-in templates when nothing was observed', () => {
    const claude = store.resolveClientIdentityProfile({ downstreamFormat: 'claude', sessionSeed: 's' });
    expect(claude.source).toBe('builtin');
    expect(claude.bodyTraits).toBeNull();
    expect(claude.downstreamHeaders['user-agent']).toBe(BUILTIN_CLAUDE_CODE_USER_AGENT);
    expect(claude.userAgent).toBe(BUILTIN_CLAUDE_CODE_USER_AGENT);
    expect(claude.downstreamHeaders['x-claude-code-session-id']).toMatch(/^[0-9a-f-]{36}$/);

    const responses = store.resolveClientIdentityProfile({ downstreamFormat: 'responses', sessionSeed: 's' });
    expect(responses.source).toBe('builtin');
    expect(Object.keys(responses.downstreamHeaders).sort()).toEqual(['originator', 'session-id', 'user-agent']);
    expect(responses.downstreamHeaders['user-agent']).toBe(BUILTIN_CODEX_USER_AGENT);

    const chat = store.resolveClientIdentityProfile({ downstreamFormat: 'openai', sessionSeed: 's' });
    expect(Object.keys(chat.downstreamHeaders).sort()).toEqual(['originator', 'user-agent']);
    expect(chat.downstreamHeaders['user-agent']).toBe(BUILTIN_CODEX_USER_AGENT);
    expect(chat.sessionId).toBeNull();
  });

  it('keeps the neutral SDK identity on the provider-header path', () => {
    const sdk = store.resolveSdkClientIdentityProfile('identity:1:2');
    expect(sdk.source).toBe('sdk');
    expect(sdk.downstreamHeaders).toEqual({});
    expect(sdk.providerHeaders['user-agent']).toBe('OpenAI/JS 4.104.0');
    expect(sdk.providerHeaders['x-stainless-lang']).toBe('js');
  });

  it('persists, hydrates and discards', async () => {
    store.recordObservedClientIdentity({
      clientKind: 'codex',
      downstreamFormat: 'responses',
      headers: CODEX_RESPONSES_FIXTURE_HEADERS,
      body: { stream: true, store: false },
    });
    await store.flushObservedClientIdentityPersistence();
    const row = await db.select().from(schema.settings)
      .where(eq(schema.settings.key, store.OBSERVED_CLIENT_IDENTITY_SETTING_KEY)).get();
    expect(row?.value).toContain('codex_cli_rs/0.114.0');
    expect(row?.value).not.toContain('764219db');

    store.resetObservedClientIdentityStoreForTests();
    expect(store.listObservedClientIdentities()).toEqual([]);
    await store.hydrateObservedClientIdentitiesFromSettings();
    const hydrated = store.getObservedClientIdentity('codex', 'responses');
    expect(hydrated?.sessionHeaderNames).toEqual(['session-id']);
    expect(hydrated?.bodyTraits.store).toBe(false);

    await store.discardObservedClientIdentities();
    expect(store.listObservedClientIdentities()).toEqual([]);
    await store.hydrateObservedClientIdentitiesFromSettings();
    expect(store.listObservedClientIdentities()).toEqual([]);
  });

  it('rejects hand-edited rows that smuggle headers through the session names', async () => {
    await db.insert(schema.settings).values({
      key: store.OBSERVED_CLIENT_IDENTITY_SETTING_KEY,
      value: JSON.stringify({
        'codex|openai': [{
          clientKind: 'codex',
          downstreamFormat: 'openai',
          headers: { 'user-agent': 'codex_cli_rs/0.114.0', authorization: 'Bearer leak' },
          sessionHeaderNames: ['authorization', 'session-id'],
          bodyTraits: { stream: 'yes' },
          firstSeenAt: '2026-10-28T00:00:00.000Z',
          lastSeenAt: '2026-10-28T00:00:00.000Z',
          count: 3,
        }],
      }),
    }).run();
    await store.hydrateObservedClientIdentitiesFromSettings();
    const entry = store.getObservedClientIdentity('codex', 'openai')!;
    expect(entry.headers).toEqual({ 'user-agent': 'codex_cli_rs/0.114.0' });
    expect(entry.sessionHeaderNames).toEqual(['session-id']);
    expect(entry.bodyTraits).toEqual({});
  });

  it('drops persisted rows an earlier build learned from a third-party SDK', async () => {
    const row = (userAgent: string, lastSeenAt: string) => ({
      clientKind: 'codex',
      downstreamFormat: 'openai',
      headers: { 'user-agent': userAgent },
      sessionHeaderNames: [],
      bodyTraits: {},
      firstSeenAt: lastSeenAt,
      lastSeenAt,
      count: 1,
    });
    await db.insert(schema.settings).values({
      key: store.OBSERVED_CLIENT_IDENTITY_SETTING_KEY,
      value: JSON.stringify({
        'codex|openai': [
          // The polluted row is the most recent one, so it would otherwise be the default.
          row('OpenAI/JS 4.104.0', '2026-10-29T00:00:00.000Z'),
          row('codex_cli_rs/0.114.0', '2026-10-28T00:00:00.000Z'),
        ],
      }),
    }).run();
    await store.hydrateObservedClientIdentitiesFromSettings();
    expect(store.listObservedClientIdentities().map((entry) => entry.headers['user-agent']))
      .toEqual(['codex_cli_rs/0.114.0']);
  });
});
