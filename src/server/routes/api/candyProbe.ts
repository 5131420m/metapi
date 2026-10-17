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
import type { CandyFingerprintId } from '../../services/candyProbe/fingerprints.js';

const CANDY_PROBE_FINGERPRINT_IDS = new Set<CandyFingerprintId>([
  'claude_code',
  'codex',
  'generic_openai',
]);

const CANDY_PROBE_MIN_QUESTIONS = 1;
const CANDY_PROBE_MAX_QUESTIONS = 6;

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
  return CANDY_PROBE_FINGERPRINT_IDS.has(normalized as CandyFingerprintId)
    ? normalized as CandyFingerprintId
    : null;
}

function parseQuestionCount(raw: unknown): number | undefined | null {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  const normalized = Math.trunc(raw);
  if (normalized < CANDY_PROBE_MIN_QUESTIONS || normalized > CANDY_PROBE_MAX_QUESTIONS) return null;
  return normalized;
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

  // Run one manual probe. The verdict is display-only: no routing/health side effects.
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
          message: '无效的指纹类型，可选值：auto、claude_code、codex、generic_openai',
        });
      }
      const questionCount = parseQuestionCount(body.questionCount);
      if (questionCount === null) {
        return reply.code(400).send({
          success: false,
          message: `题量必须是 ${CANDY_PROBE_MIN_QUESTIONS}-${CANDY_PROBE_MAX_QUESTIONS} 之间的整数`,
        });
      }

      try {
        const result = await runChannelCandyProbe({
          channelId,
          fingerprint,
          questionCount,
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
