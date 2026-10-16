/**
 * Turns "the upstream went quiet mid-stream" into the reader error the rest of the proxy already
 * knows how to handle.
 *
 * The existing observed-timeout budget covers only the wait for the FIRST readable chunk
 * (`fetchWithObservedFirstByte`). Once a chunk has arrived that timer is cleared and nothing
 * watches the socket again, so a channel that stops sending while keeping the connection open
 * hangs the downstream request indefinitely: no bytes reach the client, no error is raised, and
 * the client's own request just sits there.
 *
 * This wrapper arms a timer per read instead. A tripped read surfaces as an ordinary reader
 * error, which means every downstream consequence is already implemented and does not need a
 * second code path here: the stream session records it, the surface fails over to another channel
 * when nothing was committed yet, and after a commit the in-band terminal frame carries the
 * post-commit failure text.
 *
 * Deliberately a reader wrapper rather than a session-level watchdog: the surfaces already own
 * "what to do when the reader fails", and duplicating that decision (or racing it) would give two
 * answers to one failure.
 */

/** The subset of a stream reader this wrapper needs; kept structural so callers need no import. */
export type IdleWatchableReader = {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(reason?: unknown): Promise<unknown>;
  releaseLock(): void;
};

/**
 * Thrown by a tripped read. The message names a timeout on purpose: after a commit the client
 * sees this text (when the downstream key is outside the resilient scope), and clients classify
 * timeout wording as a retryable transport failure rather than as an unknown error.
 */
export class StreamIdleTimeoutError extends Error {
  readonly idleTimeoutMs: number;

  constructor(message: string, idleTimeoutMs: number) {
    super(message);
    this.name = 'StreamIdleTimeoutError';
    this.idleTimeoutMs = idleTimeoutMs;
  }
}

export function buildStreamIdleTimeoutMessage(idleTimeoutMs: number): string {
  const seconds = Math.max(1, Math.round(idleTimeoutMs / 1000));
  return `upstream stream idle timeout (${seconds}s without data)`;
}

/**
 * Wraps `reader` so that a read which produces nothing for `idleTimeoutMs` fails instead of
 * waiting forever.
 *
 * `idleTimeoutMs <= 0` returns the reader untouched — the budget being disabled has to mean
 * "no deadline", not "some other deadline". A null/undefined reader is passed through as well:
 * callers hand the stream session whatever they managed to obtain, and a missing reader is the
 * session's business, not this wrapper's.
 *
 * Single-consumer contract: the stream lifecycle issues one read at a time, so one timer per
 * reader is enough. Concurrent reads would share it and shorten each other's budget.
 */
export function withStreamIdleTimeout<T extends IdleWatchableReader | null | undefined>(
  reader: T,
  options: {
    idleTimeoutMs?: number | null;
    message?: string;
    /** Called once, before the tripped read rejects — for aborting the upstream request. */
    onTimeout?: () => void;
  } = {},
): T {
  const idleTimeoutMs = Math.max(0, Math.trunc(options.idleTimeoutMs ?? 0));
  if (!reader || idleTimeoutMs <= 0) return reader;

  const message = options.message ?? buildStreamIdleTimeoutMessage(idleTimeoutMs);
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
  };

  const trip = () => {
    timedOut = true;
    clearTimer();
    try {
      options.onTimeout?.();
    } catch {
      // A throwing timeout hook must not change which error the reader reports.
    }
    // Tear the upstream connection down instead of leaving it open behind a failed read.
    void Promise.resolve()
      .then(() => reader.cancel())
      .catch(() => {});
  };

  return {
    async read() {
      // The stream is already dead; every later read fails the same way rather than hanging.
      if (timedOut) throw new StreamIdleTimeoutError(message, idleTimeoutMs);
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          trip();
          reject(new StreamIdleTimeoutError(message, idleTimeoutMs));
        }, idleTimeoutMs);
      });
      try {
        const result = await Promise.race([reader.read(), timeout]);
        clearTimer();
        return result;
      } catch (error) {
        clearTimer();
        throw error;
      }
    },
    async cancel(reason?: unknown) {
      clearTimer();
      return reader.cancel(reason);
    },
    releaseLock() {
      clearTimer();
      reader.releaseLock();
    },
  } as T;
}
