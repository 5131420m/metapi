/**
 * Type declarations for the candy-question probe markers.
 *
 * `src/shared` ships hand-written `.js` + `.d.ts` pairs because the server program
 * (`tsconfig.server.json`) has `rootDir: src/server` and the web bundle needs the same
 * values; see `scripts/dev/copy-runtime-db-generated.ts` for the build-time copy.
 */

/** `client_family` value written on every probe usage-log row. */
export declare const CANDY_PROBE_CLIENT_FAMILY: 'candy_probe';

/** Fixed `client_app_name` for probe rows; the verdict travels in `error_message`. */
export declare const CANDY_PROBE_CLIENT_APP_NAME: '糖果题检测';
