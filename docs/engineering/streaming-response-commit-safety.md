# Streaming response commit safety

## Scope

This note tracks the `Cannot set headers after they are sent to the client` / `ERR_HTTP_HEADERS_SENT` failure observed on streaming Responses requests that fall back to an upstream Chat Completions endpoint.

Explicitly deferred: do not change the native Codex provider's final header reconstruction to preserve `x-codex-window-id`. The existing generic Responses and Responses-to-Chat passthrough behavior remains in scope, but `src/server/proxy-core/providers/headerUtils.ts` must not be changed for that deferred item.

## Confirmed code risks

1. Responses SSE startup is not idempotent. `openAiResponsesSurface.ts` can call `reply.hijack()` and then `setHeader()` without a `streamStarted` guard, unlike `chatSurface.ts`.
2. Both Responses and Chat surfaces have outer catch branches that may call `reply.code(...).send(...)` after SSE has been hijacked or written.
3. Those catch branches may also retry another channel after response commitment. Retrying after downstream bytes are visible can mix two upstream streams or initialize response headers twice.
4. Post-stream bookkeeping/debug failures must be best-effort and must not escape into HTTP response handling after the response is committed.

## Required invariants

- SSE response initialization is idempotent.
- Before response commitment, existing HTTP error and channel-retry behavior remains unchanged.
- After response commitment, no code may call `reply.code()`, `reply.send()`, or start another protocol/channel attempt.
- If the raw response is still writable, stream failure is terminated in-band; if it is already ended or destroyed, only logging/cleanup is allowed.
- Chat and Responses surfaces obey the same commitment boundary.
- Native Codex provider header reconstruction is unchanged in this work.

## Repair sequence

1. [done] Add red regression coverage for an exception after stream commitment.
2. [done] Add idempotent stream-start tracking to the Responses surface.
3. [done] Guard Responses catch/retry paths after commitment.
4. [done] Add regression coverage for the equivalent Chat surface path.
5. [done] Guard Chat catch/retry paths after commitment.
6. [done] Make post-stream bookkeeping and debug finalization best-effort where exceptions can currently reach the outer catch.
7. [done] Run focused proxy tests, server typecheck, and server build.

## Implementation result

- Shared stream lifecycle now supports an optional in-band error callback while preserving throw-through behavior for consumers that do not opt in.
- Responses transformation converts reader failures into `response.failed` plus `[DONE]` before closing the existing SSE response.
- Chat transformation emits an in-band error plus the protocol terminator for reader failures and closes the existing stream without attempting a second HTTP response.
- A reader failure after an already-emitted Responses terminal preserves that terminal and only appends `[DONE]`; it never emits a contradictory `response.failed`.
- Shared lifecycle error conversion is intentionally limited to `reader.read()` failures. Parser, transformer, downstream-write, and EOF-handler errors still propagate rather than being mislabeled as upstream transport failures.
- Both surface handlers treat an initialized/hijacked response as committed and do not retry channels or call `reply.code(...).send(...)` after that boundary.
- The native Codex provider final header reconstruction remains unchanged; `x-codex-window-id` preservation there is still deferred.

## Verification targets

- `src/server/routes/proxy/chat.stream.test.ts`
- Responses route/surface streaming tests under `src/server/routes/proxy/`
- `npm run typecheck:server`
- `npm run build:server`
