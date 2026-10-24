/**
 * Deadline mechanics shared by metapi's own probe runs (channel candy probe, runtime model
 * probe).
 *
 * A probe is a button click or a scheduled sweep: it must always finish, and it must never
 * wait forever on an upstream that accepted the connection and then went quiet. Both probes
 * need the same three things, and they used to each grow their own copy:
 *
 * - one deadline computed once, so every phase budgets against the same instant;
 * - `remainingTimeoutMs()`, so a later phase inherits what the earlier phases left rather
 *   than getting a fresh full budget (which is how a "25s probe" could take 50s);
 * - a single timer per phase: the timer that rejects is also the timer that aborts, so the
 *   upstream request is torn down instead of being left to run to completion in the
 *   background.
 */

export type ProbeDeadline = {
  /** When the run started, for latency reporting. */
  startedAtMs: number;
  /** The budget the run was given. */
  timeoutMs: number;
  /** The instant the run must be done by. */
  deadlineAtMs: number;
  /** Aborts the in-flight upstream request when the deadline wins. */
  abortController: AbortController;
};

export function createProbeDeadline(timeoutMs: number): ProbeDeadline {
  const startedAtMs = Date.now();
  const normalizedTimeoutMs = Math.max(1, Math.trunc(timeoutMs));
  return {
    startedAtMs,
    timeoutMs: normalizedTimeoutMs,
    deadlineAtMs: startedAtMs + normalizedTimeoutMs,
    abortController: new AbortController(),
  };
}

/**
 * What is left of the run's budget.
 *
 * Throws when the budget is already gone, which is the honest outcome: a phase that starts
 * after its deadline has passed must not be handed a fresh timeout.
 */
export function remainingTimeoutMs(deadline: ProbeDeadline, timeoutLabel: string): number {
  const remainingMs = deadline.deadlineAtMs - Date.now();
  if (remainingMs <= 0) {
    throw new Error(timeoutLabel);
  }
  return remainingMs;
}

/** Bound one phase that has no cancellation of its own (e.g. a metadata lookup). */
export async function withTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      fn(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Run the execution phase under the deadline, using ONE timer for both the rejection and
 * the abort.
 *
 * The execution is not awaited after the deadline wins: it may settle much later, and that
 * late settlement must not surface as an unhandled rejection.
 */
export async function runWithDeadline<T>(input: {
  execute: () => Promise<T>;
  deadline: ProbeDeadline;
  timeoutMessage: string;
}): Promise<T> {
  const execution = input.execute();
  execution.catch(() => undefined);

  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      execution,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          input.deadline.abortController.abort(new Error(input.timeoutMessage));
          reject(new Error(input.timeoutMessage));
        }, Math.max(1, input.deadline.deadlineAtMs - Date.now()));
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
