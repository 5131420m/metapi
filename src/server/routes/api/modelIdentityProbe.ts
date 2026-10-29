/**
 * Model fingerprint (identity) probe HTTP surface.
 *
 * Thin adapter only: argument validation and status mapping. The probe is owned by
 * `modelIdentityProbeService` (routes do not own orchestration). A verdict never changes
 * routing.
 */

import type { FastifyInstance } from 'fastify';
import {
  getIdentityProbeResultForChannel,
  IdentityProbeRequestError,
  runChannelIdentityProbe,
} from '../../services/modelIdentityProbeService.js';

function parseChannelId(raw: unknown): number | null {
  const parsed = typeof raw === 'string' && raw.trim() ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

export async function modelIdentityProbeRoutes(app: FastifyInstance) {
  // Last recorded result, including candidates and per-challenge detail.
  app.get<{ Params: { channelId: string } }>(
    '/api/channels/:channelId/identity-probe',
    async (request, reply) => {
      const channelId = parseChannelId(request.params.channelId);
      if (channelId === null) {
        return reply.code(400).send({ success: false, message: '无效的通道 ID' });
      }
      return { success: true, result: getIdentityProbeResultForChannel(channelId) };
    },
  );

  // Run one detection round (three challenges). Optional body: { clientIdentity }.
  app.post<{ Params: { channelId: string }; Body: { clientIdentity?: unknown } | undefined }>(
    '/api/channels/:channelId/identity-probe',
    async (request, reply) => {
      const channelId = parseChannelId(request.params.channelId);
      if (channelId === null) {
        return reply.code(400).send({ success: false, message: '无效的通道 ID' });
      }
      const rawClientIdentity = request.body?.clientIdentity;
      if (rawClientIdentity !== undefined && rawClientIdentity !== 'observed' && rawClientIdentity !== 'sdk') {
        return reply.code(400).send({ success: false, message: 'clientIdentity 只能是 observed 或 sdk' });
      }
      try {
        const result = await runChannelIdentityProbe({
          channelId,
          requestId: request.id,
          ...(rawClientIdentity ? { clientIdentity: rawClientIdentity } : {}),
        });
        return { success: true, result };
      } catch (error) {
        if (error instanceof IdentityProbeRequestError) {
          return reply.code(error.statusCode).send({ success: false, message: error.message });
        }
        throw error;
      }
    },
  );
}
