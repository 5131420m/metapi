/**
 * Shared channel context for metapi's own probe runs.
 *
 * Two features probe a channel with a real upstream request — the candy-question degrade
 * probe and the channel recovery probe — and both need the same three answers before they
 * can start: which model name to ask for, which credential to use, and which channel row the
 * request belongs to. Those resolvers were copied verbatim into both services, so a fix to
 * one (an OAuth fallback, a token-readiness rule) silently left the other behind. They live
 * here now, and both callers use them.
 */

import { isExactTokenRouteModelPattern } from '../../shared/tokenRoutePatterns.js';
import { getOauthInfoFromAccount } from './oauth/oauthAccount.js';
import { isUsableAccountToken } from './accountTokenService.js';
import type { schema } from '../db/index.js';

/** The joined channel row both probes read. */
export type ProbeChannelRow = {
  route_channels: typeof schema.routeChannels.$inferSelect;
  token_routes: typeof schema.tokenRoutes.$inferSelect;
  accounts: typeof schema.accounts.$inferSelect;
  sites: typeof schema.sites.$inferSelect;
  account_tokens: typeof schema.accountTokens.$inferSelect | null;
};

/**
 * The model name to send upstream.
 *
 * A channel's own `sourceModel` wins; a route whose pattern is a single exact model name is
 * an acceptable fallback. A wildcard/regex pattern is not: it names a family, not a model,
 * and sending it upstream would probe something nobody asked for.
 */
export function resolveProbeModelName(row: {
  route_channels: typeof schema.routeChannels.$inferSelect;
  token_routes: typeof schema.tokenRoutes.$inferSelect;
}): string {
  const sourceModel = String(row.route_channels.sourceModel || '').trim();
  if (sourceModel) return sourceModel;
  const routeModelPattern = String(row.token_routes.modelPattern || '').trim();
  return isExactTokenRouteModelPattern(routeModelPattern) ? routeModelPattern : '';
}

/**
 * The credential to authenticate the probe with, or null when the channel has none usable.
 *
 * A bound token must be ready (`isUsableAccountToken`); an OAuth account uses its access
 * token; everything else falls back to the account's API token.
 */
export function resolveProbeTokenValue(row: {
  route_channels: typeof schema.routeChannels.$inferSelect;
  accounts: typeof schema.accounts.$inferSelect;
  account_tokens: typeof schema.accountTokens.$inferSelect | null;
}): string | null {
  if (typeof row.route_channels.tokenId === 'number' && row.route_channels.tokenId > 0) {
    if (!row.account_tokens || !isUsableAccountToken(row.account_tokens)) return null;
    const tokenValue = String(row.account_tokens.token || '').trim();
    return tokenValue || null;
  }

  if (getOauthInfoFromAccount(row.accounts)) {
    const accessToken = String(row.accounts.accessToken || '').trim();
    return accessToken || null;
  }

  const fallbackApiToken = String(row.accounts.apiToken || '').trim();
  return fallbackApiToken || null;
}
