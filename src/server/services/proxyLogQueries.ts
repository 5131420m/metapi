/**
 * Proxy-log read policy.
 *
 * Probe traffic (metapi's own candy-question runs) is written to `proxy_logs` so it is
 * auditable in 使用日志, but it is not user demand. Two kinds of reader therefore exist,
 * and every reader has to say which it is:
 *
 * - **Row-level views** (the usage-log list, its total, its filter options, a single log
 *   detail, the global search, backups) show and count probe rows. They are what makes the
 *   audit trail visible, and a list whose paging disagreed with its rows would be a bug in
 *   itself. Mark them with `PROXY_LOG_VIEW_INCLUDES_PROBE`.
 * - **Aggregates** (dashboard, daily summary, usage/billing projection, per-key and
 *   trend stats, account overview, model stats) must exclude them, or a button click
 *   changes a dashboard: the probe writes `status: 'success'` for pass and fail, and
 *   `'failed'` for inconclusive, so its rows move both success rate and failure counts.
 *   Every one of those queries adds `meteredProxyLogCondition()`.
 *
 * `proxyLogReads.architecture.test.ts` enforces both halves mechanically, so a new
 * aggregate cannot quietly forget.
 */

import { isNull, notInArray, or } from 'drizzle-orm';
import { schema } from '../db/index.js';
import { CANDY_PROBE_CLIENT_FAMILY } from '../../shared/candyProbe.js';
import { IDENTITY_PROBE_CLIENT_FAMILY } from '../../shared/modelIdentityProbe.js';

/**
 * Marks a query as a row-level view that intentionally includes probe traffic.
 *
 * A comment token rather than a flag, because what the architecture test can check
 * mechanically is source text: the marker has to sit next to the query it describes.
 */
export const PROXY_LOG_VIEW_INCLUDES_PROBE = 'proxy-log-view: includes probe traffic';

/**
 * Every `client_family` value metapi's own probes write — the candy-question probe and the
 * model fingerprint probe. The aggregates exclude all of them; a new probe adds itself here.
 */
export const PROBE_CLIENT_FAMILIES: readonly string[] = [
  CANDY_PROBE_CLIENT_FAMILY,
  IDENTITY_PROBE_CLIENT_FAMILY,
];

/** The candy probe's family; kept for callers that only care about that one probe. */
export const PROBE_CLIENT_FAMILY = CANDY_PROBE_CLIENT_FAMILY;

/**
 * Condition for every aggregate over `proxy_logs`: keep probe traffic out.
 *
 * NULL is treated as metered on purpose. `client_family` is nullable, and a plain
 * `NOT IN ('candy_probe', …)` is NULL for those rows — SQL would then drop every legacy row
 * from the stats, which is a far worse failure than counting a probe.
 */
export function meteredProxyLogCondition() {
  return or(
    isNull(schema.proxyLogs.clientFamily),
    notInArray(schema.proxyLogs.clientFamily, [...PROBE_CLIENT_FAMILIES]),
  );
}
