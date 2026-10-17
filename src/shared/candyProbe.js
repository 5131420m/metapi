/**
 * Candy-question probe markers, shared by the server and the web UI.
 *
 * The probe is metapi's own traffic. Its usage-log rows are real rows — an operator needs
 * to be able to see when a channel was tested — but they are not user demand, so every
 * aggregate has to be able to tell them apart. That contract lives here, in one place,
 * because both sides need it: the server writes and excludes them, the web renders them.
 *
 * The read-side policy is `src/server/services/proxyLogQueries.ts`.
 */

/** `client_family` value written on every probe usage-log row. */
export const CANDY_PROBE_CLIENT_FAMILY = 'candy_probe';

/**
 * Fixed `client_app_name` for probe rows.
 *
 * Deliberately constant. The verdict text used to live here, which meant the usage-log
 * page's client filter grew one entry per verdict wording; the verdict now travels in
 * `error_message` instead.
 */
export const CANDY_PROBE_CLIENT_APP_NAME = '糖果题检测';
