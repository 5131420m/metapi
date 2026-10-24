/**
 * Candy-probe HTTP surface.
 *
 * Thin adapter only: argument validation and status mapping live here, the probe itself
 * is owned by `candyProbeService` (server layer rules: routes do not own orchestration).
 *
 * P1 exposes per-channel manual runs plus a read-back of the last verdict. There is no
 * exclusion endpoint yet — a verdict never changes routing.
 */

import type { FastifyInstance } from 'fastify';
import {
  CandyProbeRequestError,
  getCandyProbeResultForChannel,
  runChannelCandyProbe,
} from '../../services/candyProbeService.js';
import {
  isCandyFingerprintId,
  type CandyFingerprintId,
} from '../../services/candyProbe/fingerprints.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseChannelId(raw: unknown): number | null {
  const parsed = typeof raw === 'string' && raw.trim()
    ? Number.parseInt(raw, 10)
    : NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

function parseFingerprint(raw: unknown): CandyFingerprintId | 'auto' | null {
  if (raw === undefined || raw === null || raw === '') return 'auto';
  if (typeof raw !== 'string') return null;
  const normalized = raw.trim();
  if (!normalized || normalized === 'auto') return 'auto';
  return isCandyFingerprintId(normalized) ? normalized : null;
}

export async function candyProbeRoutes(app: FastifyInstance) {
  // Last recorded verdict, including the per-question detail the badge tooltip cannot show.
  app.get<{ Params: { channelId: string } }>(
    '/api/channels/:channelId/candy-probe',
    async (request, reply) => {
      const channelId = parseChannelId(request.params.channelId);
      if (channelId === null) {
        return reply.code(400).send({ success: false, message: '无效的通道 ID' });
      }
      return {
        success: true,
        result: getCandyProbeResultForChannel(channelId),
      };
    },
  );

  // Run one manual probe. The verdict is display-only: it never feeds channel routing,
  // health or cooldowns. The request itself goes through the site API endpoint pool like
  // real traffic, so its exchange outcome is recorded in the pool's endpoint state.
  app.post<{ Params: { channelId: string }; Body: unknown }>(
    '/api/channels/:channelId/candy-probe',
    async (request, reply) => {
      const channelId = parseChannelId(request.params.channelId);
      if (channelId === null) {
        return reply.code(400).send({ success: false, message: '无效的通道 ID' });
      }

      const body = isRecord(request.body) ? request.body : {};
      const fingerprint = parseFingerprint(body.fingerprint);
      if (fingerprint === null) {
        return reply.code(400).send({
          success: false,
          message: '无效的指纹类型，可选值：auto、claude_code、codex、codex_chat、generic_openai',
        });
      }
      // `sampleCount` is deliberately ignored rather than rejected: a probe is one
      // question, one answer, and an old client (or a saved curl) sending the retired
      // field must not start failing.

      try {
        const result = await runChannelCandyProbe({
          channelId,
          fingerprint,
          requestId: request.id,
        });
        return { success: true, result };
      } catch (error) {
        if (error instanceof CandyProbeRequestError) {
          return reply.code(error.statusCode).send({ success: false, message: error.message });
        }
        throw error;
      }
    },
  );
}
