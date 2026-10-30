/**
 * Contract: a synthetic request wearing the observed client identity reaches the upstream
 * with the same identity headers as the real request it was learned from.
 *
 * The candy probe, the model fingerprint probe and the playground do not go through the
 * proxy surfaces; they call `buildUpstreamEndpointRequest` directly with the identity from
 * `resolveClientIdentityProfile`. Both paths share the builder, so the only way they drift is
 * in what each passes in. This pins that: real Claude Code traffic (as CPA's cloak sends it)
 * and a probe replaying the learned identity must produce identical upstream identity headers,
 * and the downstream `anthropic-beta` must reach the upstream unchanged.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CLAUDE_CODE_FIXTURE_HEADERS } from '../test-fixtures/observedClientIdentityFixtures.js';

type StoreModule = typeof import('./observedClientIdentity.js');
type BuilderModule = typeof import('./upstreamRequestBuilder.js');

/** Headers that identify the client; everything else (auth, framing) is per request. */
const IDENTITY_HEADER_NAMES = [
  'anthropic-beta',
  'anthropic-version',
  'user-agent',
  'x-app',
  'x-stainless-arch',
  'x-stainless-lang',
  'x-stainless-os',
  'x-stainless-package-version',
  'x-stainless-runtime',
  'x-stainless-runtime-version',
  'x-stainless-timeout',
] as const;

function identityHeaders(headers: Record<string, string>): Record<string, string> {
  const lower = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return Object.fromEntries(IDENTITY_HEADER_NAMES.map((name) => [name, lower[name]]));
}

const CLAUDE_BODY = {
  model: 'claude-opus-5-5',
  max_tokens: 1024,
  stream: true,
  messages: [{ role: 'user', content: 'hello' }],
};

describe('client identity request contract (Claude)', () => {
  let store: StoreModule;
  let builder: BuilderModule;
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-identity-contract-'));
    process.env.DATA_DIR = dataDir;
    await import('../db/migrate.js');
    store = await import('./observedClientIdentity.js');
    builder = await import('./upstreamRequestBuilder.js');
  });

  beforeEach(() => {
    store.resetObservedClientIdentityStoreForTests();
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

  // sub2api / new-api sites take an API key; `claude` is Anthropic itself (API key here).
  for (const sitePlatform of ['sub2api', 'new-api', 'claude'] as const) {
    it(`gives real traffic and the probe the same upstream identity on ${sitePlatform}`, () => {
      const realDownstreamHeaders = {
        ...CLAUDE_CODE_FIXTURE_HEADERS,
        authorization: 'Bearer sk-downstream',
      };
      const real = builder.buildUpstreamEndpointRequest({
        endpoint: 'messages',
        modelName: 'claude-opus-5-5',
        stream: true,
        tokenValue: 'sk-upstream',
        sitePlatform,
        openaiBody: CLAUDE_BODY,
        downstreamFormat: 'claude',
        claudeOriginalBody: CLAUDE_BODY,
        downstreamHeaders: realDownstreamHeaders,
        providerHeaders: {},
      });

      store.recordObservedClientIdentity({
        clientKind: 'claude_code',
        downstreamFormat: 'claude',
        headers: realDownstreamHeaders,
        body: CLAUDE_BODY,
      });
      const identity = store.resolveClientIdentityProfile({ downstreamFormat: 'claude', sessionSeed: 'contract' });
      expect(identity.source).toBe('observed');
      const probe = builder.buildUpstreamEndpointRequest({
        endpoint: 'messages',
        modelName: 'claude-opus-5-5',
        stream: true,
        tokenValue: 'sk-upstream',
        sitePlatform,
        openaiBody: CLAUDE_BODY,
        downstreamFormat: 'claude',
        claudeOriginalBody: CLAUDE_BODY,
        downstreamHeaders: identity.downstreamHeaders,
        providerHeaders: identity.providerHeaders,
      });

      expect(identityHeaders(probe.headers)).toEqual(identityHeaders(real.headers));
      // The beta Claude Code built for its own version goes upstream exactly as it came in.
      expect(identityHeaders(real.headers)['anthropic-beta']).toBe(CLAUDE_CODE_FIXTURE_HEADERS['anthropic-beta']);
      expect(identityHeaders(real.headers)['user-agent']).toBe(CLAUDE_CODE_FIXTURE_HEADERS['user-agent']);
      expect(identityHeaders(real.headers)['x-stainless-os']).toBe(CLAUDE_CODE_FIXTURE_HEADERS['x-stainless-os']);
    });
  }
});
