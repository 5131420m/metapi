import { db, schema } from '../db/index.js';
import { eq, inArray } from 'drizzle-orm';
import { sendNotification } from './notifyService.js';
import { setAccountRuntimeHealth } from './accountHealthService.js';
import { appendSessionTokenRebindHint } from './alertRules.js';
import { formatUtcSqlDateTime } from './localTimeService.js';
import { registerAccountAuthFailure, resetAccountAuthFailureStreak } from './accountAuthFailureStreak.js';

/**
 * Routes whose channels are all backed (directly or through an OAuth route unit) by
 * the given account. After the account leaves routing, any of these routes whose
 * candidate set drops to zero has just lost its last credential — the silent
 * "model no longer routed" case this escalation exists to name.
 *
 * Eligibility is NOT re-implemented here: the router's own
 * `explainSelectionRouteWide` decides, so cooldowns, unit membership, account
 * status and channel flags all resolve exactly as they would for a real request.
 */
async function resolveModelsLosingLastCredential(accountId: number): Promise<string[]> {
  const { tokenRouter } = await import('./tokenRouter.js');

  const directRouteRows = await db.select({ routeId: schema.routeChannels.routeId })
    .from(schema.routeChannels)
    .where(eq(schema.routeChannels.accountId, accountId)).all();

  const memberUnitRows = await db.select({ unitId: schema.oauthRouteUnitMembers.unitId })
    .from(schema.oauthRouteUnitMembers)
    .where(eq(schema.oauthRouteUnitMembers.accountId, accountId)).all();
  const unitRouteRows = memberUnitRows.length > 0
    ? await db.select({ routeId: schema.routeChannels.routeId })
      .from(schema.routeChannels)
      .where(inArray(schema.routeChannels.oauthRouteUnitId, memberUnitRows.map((row) => row.unitId))).all()
    : [];

  const routeIds = Array.from(new Set([
    ...directRouteRows.map((row) => row.routeId),
    ...unitRouteRows.map((row) => row.routeId),
  ].filter((routeId): routeId is number => Number.isFinite(routeId))));
  if (routeIds.length === 0) return [];

  const routeRows = await db.select({
    id: schema.tokenRoutes.id,
    modelPattern: schema.tokenRoutes.modelPattern,
    displayName: schema.tokenRoutes.displayName,
  }).from(schema.tokenRoutes)
    .where(inArray(schema.tokenRoutes.id, routeIds)).all();

  const deadModels: string[] = [];
  for (const route of routeRows) {
    const explanation = await tokenRouter.explainSelectionRouteWide(route.id);
    const hasEligible = (explanation.candidates || []).some((candidate) => candidate.eligible);
    if (!hasEligible) {
      deadModels.push(route.displayName?.trim() || route.modelPattern);
    }
  }
  return deadModels;
}

export async function reportTokenExpired(params: {
  accountId: number;
  username?: string | null;
  siteName?: string | null;
  detail?: string;
}) {
  const accountLabel = params.username || `ID:${params.accountId}`;
  const siteLabel = params.siteName || 'unknown-site';
  const detailText = params.detail ? appendSessionTokenRebindHint(params.detail) : '';
  const detail = detailText ? ` (${detailText})` : '';
  const createdAt = formatUtcSqlDateTime(new Date());

  // Confirmation gate: one 401 must not remove a credential from routing. A lone
  // strike stays observability-only (warning event, no state change, no push), so
  // a transient gateway 401 costs nothing; a genuinely dead key confirms on the
  // next request, which under normal traffic arrives within seconds.
  const confirmed = registerAccountAuthFailure(params.accountId);
  if (!confirmed) {
    await db.insert(schema.events).values({
      type: 'token',
      title: '凭据疑似失效（未确认）',
      message: `${accountLabel} @ ${siteLabel} 的凭据遇到认证错误${detail}；第 1 次，连续 2 次且期间无成功请求将标记失效`,
      level: 'warning',
      relatedId: params.accountId,
      relatedType: 'account',
      createdAt,
    }).run();
    return;
  }
  resetAccountAuthFailureStreak(params.accountId);

  await db.insert(schema.events).values({
    type: 'token',
    title: 'Token 已失效',
    message: `${accountLabel} @ ${siteLabel} 的 Token 无效或已过期${detail}`,
    level: 'error',
    relatedId: params.accountId,
    relatedType: 'account',
    createdAt,
  }).run();

  await db.update(schema.accounts).set({
    status: 'expired',
    updatedAt: new Date().toISOString(),
  }).where(eq(schema.accounts.id, params.accountId)).run();

  setAccountRuntimeHealth(params.accountId, {
    state: 'unhealthy',
    reason: detailText ? `访问令牌失效：${detailText}` : '访问令牌失效',
    source: 'auth',
  });

  await sendNotification(
    'Token 已失效',
    `${accountLabel} @ ${siteLabel} 的 Token 无效或已过期${detail}`,
    'error',
  );

  // Name the silent blast radius: routes that just lost their last eligible
  // channel because every surviving channel depended on this account.
  const deadModels = await resolveModelsLosingLastCredential(params.accountId);
  if (deadModels.length > 0) {
    const modelList = deadModels.join('、');
    const message = `模型 ${modelList} 的可用通道全部来自账号 ${accountLabel} @ ${siteLabel}，该账号凭据失效后模型不再进入路由`;
    await db.insert(schema.events).values({
      type: 'route',
      title: '模型因凭据失效不再可用',
      message,
      level: 'error',
      relatedId: params.accountId,
      relatedType: 'route',
      createdAt: formatUtcSqlDateTime(new Date()),
    }).run();
    await sendNotification('模型因凭据失效不再可用', message, 'error');
  }
}

/**
 * Background probes (balance refresh, check-in) only SUSPECT auth failure: their
 * 401s can come from network or proxy trouble with the account's key perfectly
 * fine, so they must not own the hard expiry transition — and they do not feed
 * the confirmation streak either, since they lack the "a real request walked the
 * path" evidence. Event + notification for a human to verify, nothing more.
 */
export async function noteAccountAuthFailureSuspected(params: {
  accountId: number;
  username?: string | null;
  siteName?: string | null;
  detail?: string;
}) {
  const accountLabel = params.username || `ID:${params.accountId}`;
  const siteLabel = params.siteName || 'unknown-site';
  const detailText = params.detail ? appendSessionTokenRebindHint(params.detail) : '';
  const detail = detailText ? ` (${detailText})` : '';
  const message = `${accountLabel} @ ${siteLabel} 的后台任务遇到凭据错误${detail}；未改变账号可用性，请人工核查`;

  await db.insert(schema.events).values({
    type: 'token',
    title: '后台任务凭据疑似失效',
    message,
    level: 'warning',
    relatedId: params.accountId,
    relatedType: 'account',
    createdAt: formatUtcSqlDateTime(new Date()),
  }).run();

  await sendNotification('后台任务凭据疑似失效', message, 'warning');
}

export async function reportProxyAllFailed(params: { model: string; reason: string }) {
  const createdAt = formatUtcSqlDateTime(new Date());
  await db.insert(schema.events).values({
    type: 'proxy',
    title: '代理全部失败',
    message: `模型=${params.model}, 原因=${params.reason}`,
    level: 'error',
    relatedType: 'route',
    createdAt,
  }).run();

  await sendNotification(
    '代理全部失败',
    `模型=${params.model}, 原因=${params.reason}`,
    'error',
  );
}
