/**
 * Evidence attached to a model list returned by `PlatformAdapter.getModels`.
 *
 * An adapter returns `string[]`, so an empty array is ambiguous: it can mean
 * "the upstream answered and this account really has no models" or "every
 * discovery attempt failed / returned something we could not read, and the
 * empty array is just the fallback". Model refresh must tell these apart,
 * because the first is a reason to clear the account's synced models and the
 * second must never be.
 *
 * The rule: an empty list counts as evidence ONLY when the adapter saw a
 * well-formed, explicitly empty model-list payload. Everything else — an HTTP
 * error, an unreadable body, an HTTP 200 carrying `{ success: false }` — stays
 * unconfirmed, and model refresh treats it as a failed pull.
 *
 * Marking is out of band (a WeakSet keyed on the returned array) so that the
 * `Promise<string[]>` contract and every other caller stay unchanged: callers
 * that only care about the names keep working untouched.
 */
const confirmedEmptyModelLists = new WeakSet<readonly string[]>();

/**
 * Build the empty model list to return when the upstream explicitly reported
 * zero models. Only use it after validating the payload shape.
 */
export function confirmedEmptyModelList(): string[] {
  const models: string[] = [];
  confirmedEmptyModelLists.add(models);
  return models;
}

/**
 * Mark an already-built list as confirmed when it turned out to be empty, for
 * adapters that parse first and inspect afterwards. Non-empty lists are
 * returned unchanged: a list with names needs no emptiness evidence.
 */
export function markConfirmedEmptyModelList(models: string[]): string[] {
  if (models.length === 0) confirmedEmptyModelLists.add(models);
  return models;
}

/**
 * True when this exact empty list carries the "upstream reported zero models"
 * evidence. A non-empty list is never "confirmed empty".
 */
export function isConfirmedEmptyModelList(models: readonly string[]): boolean {
  return models.length === 0 && confirmedEmptyModelLists.has(models);
}

/**
 * Does this payload look like an error envelope rather than a model list?
 *
 * new-api style backends answer HTTP 200 with `{ success: false, message }`
 * for auth and permission failures, so a 200 is not on its own proof that the
 * body is a model listing.
 */
export function looksLikeErrorEnvelope(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const record = payload as { success?: unknown; error?: unknown };
  if (record.success === false) return true;
  return !!record.error;
}

/**
 * An unreadable model-list payload. Worded to avoid the keywords
 * `classifyModelDiscoveryError` scans for ("invalid", "unauthorized", …) so an
 * unreadable body is not reported to users as an expired API key; an upstream
 * message passed through as `detail` is still classified on its own merits.
 */
export function unreadableModelListError(source: string, detail?: unknown): Error {
  const suffix = String(
    (detail && typeof detail === 'object' ? (detail as { message?: unknown }).message : detail) ?? '',
  ).trim();
  return new Error(
    `unreadable model list payload from ${source}${suffix ? `: ${suffix}` : ''}`,
  );
}
