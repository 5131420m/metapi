/**
 * In-memory consecutive auth-failure streak per account — the confirmation gate in
 * front of the hard `expired` transition.
 *
 * A single 401/403 must not remove a credential from routing: gateways hiccup,
 * signature clocks skew and providers occasionally return 401 under load. Only a
 * REPEATED auth failure — with no successful request in between (recordSuccess
 * resets the streak) and no more than the stale window apart — confirms that the
 * credential itself is dead.
 *
 * Deliberately dependency-free and process-local: the streak is short-lived
 * operational state, not something worth persisting across restarts (a restart
 * simply means the next 401 starts a fresh confirmation).
 */

const AUTH_EXPIRE_CONFIRM_THRESHOLD = 2;
/** A strike older than this stops counting toward the confirmation. */
const AUTH_STRIKE_STALE_MS = 30 * 60 * 1000;

type AuthFailureStreak = {
  count: number;
  lastFailureAtMs: number;
};

const authFailureStreaks = new Map<number, AuthFailureStreak>();

/**
 * Register one auth failure for the account. Returns true when the streak reached
 * the confirmation threshold — the caller may then perform the hard expiry.
 */
export function registerAccountAuthFailure(accountId: number, nowMs = Date.now()): boolean {
  const previous = authFailureStreaks.get(accountId);
  const count = previous && (nowMs - previous.lastFailureAtMs) < AUTH_STRIKE_STALE_MS
    ? previous.count + 1
    : 1;
  authFailureStreaks.set(accountId, { count, lastFailureAtMs: nowMs });
  return count >= AUTH_EXPIRE_CONFIRM_THRESHOLD;
}

/**
 * Clear the streak. Called on every successful request through the account: a
 * success between two 401s proves the credential still works, so the failures are
 * not consecutive. Also called right after a confirmed expiry so a re-activated
 * account does not get re-expired by its first future 401.
 */
export function resetAccountAuthFailureStreak(accountId: number): void {
  authFailureStreaks.delete(accountId);
}
