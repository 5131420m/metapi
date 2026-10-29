/**
 * Model fingerprint (identity) probe markers, shared by the server and the web UI.
 *
 * The probe asks a channel for a few hundred "random" integers and ranks the reply against
 * the lm-detector reference bank. Like the candy probe it is metapi's own traffic: its
 * usage-log rows are real rows, but not user demand, so every aggregate must be able to
 * tell them apart (see `src/server/services/proxyLogQueries.ts`).
 */

/** `client_family` value written on every identity-probe usage-log row. */
export const IDENTITY_PROBE_CLIENT_FAMILY = 'model_identity_probe';

/** Fixed `client_app_name`; the verdict travels in `error_message`. */
export const IDENTITY_PROBE_CLIENT_APP_NAME = '模型指纹检测';

/**
 * Hard ceiling for ONE run: loading the reference bank, discovery, and three challenges sent
 * one after another. The web waits longer than this, never shorter.
 */
export const IDENTITY_PROBE_MAX_TIMEOUT_MS = 900_000;

/** Challenges per run. Three valid replies are what gives the ranking a calibrated confidence. */
export const IDENTITY_PROBE_CHALLENGE_COUNT = 3;

/**
 * Model-line key: one model and its dated snapshots share a key.
 *
 * Lowercase; drop a `vendor/` prefix; drop `-latest`, an ISO or 8-digit date
 * (`-2025-09-29`, `-20250929`); write a digit-hyphen-digit version as a dot
 * (`claude-opus-4-6` → `claude-opus-4.6`, how the bank spells versions); then drop a
 * trailing 4-digit month-day snapshot suffix (`-1017`, `-0731`). Only a suffix that reads
 * as a month-day is dropped, so a size written as four digits is left alone.
 *
 * `deepseek-v4.1-flash-1017` and `deepseek-v4.1-flash` share a line; `deepseek-v4-flash`
 * does not. The server verdict and the web detail panel both compare by this key.
 */
export function identityModelLineKey(name) {
  let key = String(name || '').trim().toLowerCase();
  const slash = key.lastIndexOf('/');
  if (slash >= 0) key = key.slice(slash + 1);
  return key
    .replace(/-latest$/, '')
    .replace(/-\d{4}-\d{2}-\d{2}$/, '')
    .replace(/-\d{8}$/, '')
    .replace(/(\d)[-.](?=\d(?:\D|$))/g, '$1.')
    .replace(/-(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/, '');
}

/**
 * Short verdict labels: the usage-log note, the row badge, the toast and the detail panel
 * all read this one table, so they cannot drift apart.
 */
export const IDENTITY_PROBE_VERDICT_LABELS = Object.freeze({
  model_match: '型号一致',
  version_mismatch: '疑似换版本',
  family_match: '家族一致',
  likely_match: '倾向一致',
  mismatch: '疑似换皮',
  uncertain: '无法确认',
  not_model: '非模型输出',
  inconclusive: '未完成',
});
