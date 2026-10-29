import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CLAUDE_CODE_FIXTURE_HEADERS,
} from '../../test-fixtures/observedClientIdentityFixtures.js';

describe('client identity routes', () => {
  let app: FastifyInstance;
  let store: typeof import('../../services/observedClientIdentity.js');

  beforeAll(async () => {
    store = await import('../../services/observedClientIdentity.js');
    const routes = await import('./clientIdentity.js');
    app = Fastify();
    await app.register(routes.clientIdentityRoutes);
    await app.ready();
  });

  afterAll(async () => {
    store.resetObservedClientIdentityStoreForTests();
    await app.close();
  });

  it('lists the observed identities without credentials or session values', async () => {
    store.resetObservedClientIdentityStoreForTests();
    store.recordObservedClientIdentity({
      clientKind: 'claude_code',
      downstreamFormat: 'claude',
      headers: CLAUDE_CODE_FIXTURE_HEADERS,
    });
    const response = await app.inject({ method: 'GET', url: '/api/client-identity/observed' });
    expect(response.statusCode).toBe(200);
    const payload = response.json();
    expect(payload.success).toBe(true);
    expect(payload.identities).toHaveLength(1);
    expect(payload.identities[0]).toMatchObject({
      key: 'claude_code|claude',
      sessionHeaderNames: ['x-claude-code-session-id'],
    });
    expect(response.payload).not.toContain('sk-secret');
    expect(response.payload).not.toContain(CLAUDE_CODE_FIXTURE_HEADERS['x-claude-code-session-id']);
  });
});
