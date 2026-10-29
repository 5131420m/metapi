/**
 * Observed client identity HTTP surface (read-only).
 *
 * Thin adapter: the snapshots are owned by `observedClientIdentity`. They only ever hold
 * allowlisted identity headers, session header NAMES and body-shape traits, so returning them
 * as-is exposes no credential and no user content.
 */

import type { FastifyInstance } from 'fastify';
import { listObservedClientIdentities } from '../../services/observedClientIdentity.js';

export async function clientIdentityRoutes(app: FastifyInstance) {
  app.get('/api/client-identity/observed', async () => ({
    success: true,
    identities: listObservedClientIdentities(),
  }));
}
