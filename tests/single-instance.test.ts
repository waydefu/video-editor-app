import { describe, expect, it, vi } from "vitest";
import { acquireSingleInstanceLock, UPDATE_HANDOFF_ARG } from "../src/main/services/single-instance";

/** Fake clock: sleep advances time without real waiting. */
function fakeClock() {
  let time = 0;
  return {
    now: () => time,
    sleep: vi.fn(async (ms: number) => {
      time += ms;
    }),
  };
}

describe("single-instance lock with update handoff", () => {
  it("uses a stable handoff marker", () => {
    expect(UPDATE_HANDOFF_ARG).toBe("--sw-update-handoff");
  });

  it("with the marker, acquires once the old instance releases the lock after N tries", async () => {
    const clock = fakeClock();
    let attempts = 0;
    const requestLock = vi.fn(() => {
      attempts += 1;
      return attempts > 4; // lock frees on the 5th request
    });
    const acquired = await acquireSingleInstanceLock({
      requestLock,
      isUpdateHandoff: true,
      ...clock,
      retryIntervalMs: 250,
      maxWaitMs: 15_000,
    });
    expect(acquired).toBe(true);
    expect(requestLock).toHaveBeenCalledTimes(5);
    expect(clock.sleep).toHaveBeenCalledTimes(4);
    expect(clock.sleep.mock.calls.every(([ms]) => ms === 250)).toBe(true);
  });

  it("with the marker, gives up after the bounded wait when the lock never frees", async () => {
    const clock = fakeClock();
    const requestLock = vi.fn(() => false);
    const acquired = await acquireSingleInstanceLock({
      requestLock,
      isUpdateHandoff: true,
      ...clock,
      retryIntervalMs: 250,
      maxWaitMs: 15_000,
    });
    expect(acquired).toBe(false);
    // 1 initial request + one request per 250 ms slot until the 15 s deadline.
    expect(requestLock).toHaveBeenCalledTimes(61);
    expect(clock.sleep.mock.calls.reduce((sum, [ms]) => sum + ms, 0)).toBe(15_000);
  });

  it("without the marker, a losing process does not retry", async () => {
    const clock = fakeClock();
    const requestLock = vi.fn(() => false);
    const acquired = await acquireSingleInstanceLock({ requestLock, isUpdateHandoff: false, ...clock });
    expect(acquired).toBe(false);
    expect(requestLock).toHaveBeenCalledTimes(1);
    expect(clock.sleep).not.toHaveBeenCalled();
  });

  it("acquires immediately when the lock is free, with or without the marker", async () => {
    const clock = fakeClock();
    const requestLock = vi.fn(() => true);
    expect(await acquireSingleInstanceLock({ requestLock, isUpdateHandoff: true, ...clock })).toBe(true);
    expect(await acquireSingleInstanceLock({ requestLock, isUpdateHandoff: false, ...clock })).toBe(true);
    expect(clock.sleep).not.toHaveBeenCalled();
  });
});
