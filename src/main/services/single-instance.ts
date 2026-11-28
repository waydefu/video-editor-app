/**
 * Argument the portable update handoff adds to the relaunched executable. The old
 * process still holds the single-instance lock while it quits, so the new process
 * must wait for the lock instead of exiting immediately.
 */
export const UPDATE_HANDOFF_ARG = "--sw-update-handoff";

export interface SingleInstanceLockOptions {
  /** Wraps app.requestSingleInstanceLock(). */
  requestLock: () => boolean;
  /** True only when this process was started by the update handoff. */
  isUpdateHandoff: boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  retryIntervalMs?: number;
  maxWaitMs?: number;
}

export const SINGLE_INSTANCE_RETRY_INTERVAL_MS = 250;
export const SINGLE_INSTANCE_HANDOFF_MAX_WAIT_MS = 15_000;

/**
 * Resolves true when this process holds the lock. Without the handoff marker a
 * losing process gives up at once (the first instance keeps running and focuses).
 * With the marker it retries on a fixed interval until a bounded deadline.
 */
export async function acquireSingleInstanceLock(options: SingleInstanceLockOptions): Promise<boolean> {
  if (options.requestLock()) return true;
  if (!options.isUpdateHandoff) return false;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const interval = options.retryIntervalMs ?? SINGLE_INSTANCE_RETRY_INTERVAL_MS;
  const maxWait = options.maxWaitMs ?? SINGLE_INSTANCE_HANDOFF_MAX_WAIT_MS;
  const deadline = now() + maxWait;
  while (now() < deadline) {
    await sleep(interval);
    if (options.requestLock()) return true;
  }
  return false;
}
