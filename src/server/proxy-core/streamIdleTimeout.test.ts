import { describe, expect, it, vi } from 'vitest';
import {
  StreamIdleTimeoutError,
  buildStreamIdleTimeoutMessage,
  withStreamIdleTimeout,
} from './streamIdleTimeout.js';

type ReaderResult = { done: boolean; value?: Uint8Array };

/**
 * A reader whose reads settle only when the test says so, so "the upstream went quiet" is
 * reproducible without a real socket.
 */
function createControlledReader() {
  const pending: Array<(result: ReaderResult) => void> = [];
  const cancelled: unknown[] = [];
  let releaseCount = 0;
  const reader = {
    read(): Promise<ReaderResult> {
      return new Promise((resolve) => {
        pending.push(resolve);
      });
    },
    async cancel(reason?: unknown) {
      cancelled.push(reason);
      return undefined;
    },
    releaseLock() {
      releaseCount += 1;
    },
  };
  return {
    reader,
    deliverDone() {
      pending.shift()?.({ done: true });
    },
    deliverValue(value: Uint8Array) {
      pending.shift()?.({ done: false, value });
    },
    get pendingCount() {
      return pending.length;
    },
    get cancelled() {
      return cancelled;
    },
    get releaseCount() {
      return releaseCount;
    },
  };
}

/**
 * Records a promise's outcome. Attaching the handlers immediately matters with fake timers: a
 * rejection that fires while nothing is awaiting yet is reported as an unhandled rejection even
 * when the test asserts on it one line later.
 */
function settle<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

describe('withStreamIdleTimeout', () => {
  it('returns the reader untouched when the budget is disabled', () => {
    const control = createControlledReader();
    expect(withStreamIdleTimeout(control.reader, { idleTimeoutMs: 0 })).toBe(control.reader);
    expect(withStreamIdleTimeout(control.reader, {})).toBe(control.reader);
    expect(withStreamIdleTimeout(null, { idleTimeoutMs: 1000 })).toBeNull();
  });

  it('fails a read that produces nothing within the budget', async () => {
    vi.useFakeTimers();
    try {
      const control = createControlledReader();
      const reader = withStreamIdleTimeout(control.reader, { idleTimeoutMs: 5_000 });
      const outcome = settle(reader.read());

      await vi.advanceTimersByTimeAsync(4_999);
      expect(control.pendingCount).toBe(1);

      await vi.advanceTimersByTimeAsync(1);
      const settled = await outcome;
      expect(settled.ok).toBe(false);
      expect(settled.ok === false && settled.error).toBeInstanceOf(StreamIdleTimeoutError);
    } finally {
      vi.useRealTimers();
    }
  });

  it('names a timeout in the message, because a client classifies on that text', async () => {
    vi.useFakeTimers();
    try {
      const control = createControlledReader();
      const reader = withStreamIdleTimeout(control.reader, { idleTimeoutMs: 12_000 });
      const outcome = settle(reader.read());
      await vi.advanceTimersByTimeAsync(12_000);

      const settled = await outcome;
      expect(settled.ok).toBe(false);
      // After a commit this text is what an unscoped client sees, and timeout wording is what
      // makes it a retryable transport failure rather than an unknown error.
      const message = settled.ok === false ? String((settled.error as Error).message) : '';
      expect(message).toMatch(/timeout|timed out/i);
      expect(buildStreamIdleTimeoutMessage(12_000)).toContain('12s');
    } finally {
      vi.useRealTimers();
    }
  });

  it('tears the upstream connection down and fails later reads immediately', async () => {
    vi.useFakeTimers();
    try {
      const control = createControlledReader();
      const reader = withStreamIdleTimeout(control.reader, { idleTimeoutMs: 1_000 });
      const outcome = settle(reader.read());
      await vi.advanceTimersByTimeAsync(1_000);
      expect((await outcome).ok).toBe(false);

      // Leaving the reader open behind a failed read would leak the connection.
      expect(control.cancelled).toHaveLength(1);

      // A dead stream stays dead: no second timer, no second wait.
      expect((await settle(reader.read())).ok).toBe(false);
      expect(control.pendingCount).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('passes data through and re-arms the budget for each read', async () => {
    vi.useFakeTimers();
    try {
      const control = createControlledReader();
      const reader = withStreamIdleTimeout(control.reader, { idleTimeoutMs: 1_000 });

      const first = settle(reader.read());
      const chunk = new Uint8Array([1, 2, 3]);
      control.deliverValue(chunk);
      const firstSettled = await first;
      expect(firstSettled.ok).toBe(true);
      expect(firstSettled.ok === true && firstSettled.value).toMatchObject({ done: false, value: chunk });

      // A gap shorter than the budget must not fail a healthy stream.
      await vi.advanceTimersByTimeAsync(900);
      const second = settle(reader.read());
      await vi.advanceTimersByTimeAsync(900);
      control.deliverValue(new Uint8Array([4]));
      expect((await second).ok).toBe(true);

      // …and the cleared timer from the completed read must not fire later.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(control.cancelled).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops watching once the stream ends', async () => {
    vi.useFakeTimers();
    try {
      const control = createControlledReader();
      const reader = withStreamIdleTimeout(control.reader, { idleTimeoutMs: 1_000 });
      const read = settle(reader.read());
      control.deliverDone();
      const settled = await read;
      expect(settled.ok === true && settled.value).toMatchObject({ done: true });

      await vi.advanceTimersByTimeAsync(10_000);
      expect(control.cancelled).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a throwing timeout hook as the read failure, not as the hook error', async () => {
    vi.useFakeTimers();
    try {
      const control = createControlledReader();
      const reader = withStreamIdleTimeout(control.reader, {
        idleTimeoutMs: 500,
        onTimeout: () => {
          throw new Error('abort hook exploded');
        },
      });
      const outcome = settle(reader.read());
      await vi.advanceTimersByTimeAsync(500);

      const settled = await outcome;
      expect(settled.ok).toBe(false);
      expect(settled.ok === false && settled.error).toBeInstanceOf(StreamIdleTimeoutError);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('resolveStreamIdleTimeoutMs', () => {
  it('watches only streaming responses, sharing the first-byte budget', async () => {
    const { resolveStreamIdleTimeoutMs } = await import('./responseTimeoutPolicy.js');
    const settings = {
      proxyFirstByteTimeoutSec: 45,
      proxyNonStreamTimeoutSec: 120,
      proxyMediaTimeoutSec: 600,
    };

    expect(resolveStreamIdleTimeoutMs('stream', settings)).toBe(45_000);
    // A non-stream or media body arrives in one piece: its observed-timeout budget already
    // covers the whole wait, so there is no inter-chunk gap to watch.
    expect(resolveStreamIdleTimeoutMs('non-stream', settings)).toBe(0);
    expect(resolveStreamIdleTimeoutMs('media', settings)).toBe(0);
    // Disabling the budget must disable the watchdog too — a proxy told not to time out must not
    // acquire a hidden deadline.
    expect(resolveStreamIdleTimeoutMs('stream', { proxyFirstByteTimeoutSec: 0 })).toBe(0);
    expect(resolveStreamIdleTimeoutMs('stream', {})).toBe(0);
  });
});
