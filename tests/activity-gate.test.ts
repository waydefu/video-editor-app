import { afterEach, describe, expect, it, vi } from "vitest";
import { activityBlockReason, type ActivityState } from "../src/main/services/activity-gate";
import { PostSuccessPowerScheduler } from "../src/main/services/post-success-power";
import { RenderPowerGuard } from "../src/main/services/render-power-guard";

const IDLE: ActivityState = {
  renderInFlight: false,
  renderPreflight: false,
  projectSwitching: false,
  backgroundWork: false,
};

const successPreference = { enabled: true, trigger: "RENDER_SUCCESS" as const, action: "SLEEP" as const };

describe("shared activity gate", () => {
  it("is idle when nothing is in flight", () => {
    expect(activityBlockReason(IDLE)).toBeUndefined();
  });

  it.each([
    ["render", { renderInFlight: true }],
    ["render preflight", { renderPreflight: true }],
    ["project switch or save-as", { projectSwitching: true }],
    ["import / AI / subtitle / upload / preview", { backgroundWork: true }],
  ])("blocks while %s is in flight", (_name, patch) => {
    expect(activityBlockReason({ ...IDLE, ...patch })).toEqual(expect.any(String));
  });
});

describe("fault injection: power scheduler wiring (S-02/S-03)", () => {
  afterEach(() => vi.useRealTimers());

  it("pre-fix wiring (render guard only) lets power run while an import is in flight", async () => {
    vi.useFakeTimers();
    const executor = vi.fn(async () => undefined);
    const guard = new RenderPowerGuard({
      start: () => 1,
      isStarted: () => true,
      stop: () => undefined,
    });
    let importInFlight = true; // stands in for importController / AI / upload work
    const scheduler = new PostSuccessPowerScheduler({
      executor,
      countdownSeconds: 2,
      // Old main.ts wiring: only the render guard was consulted.
      isBusy: () => guard.isActive,
    });
    scheduler.notifySuccess("RENDER_SUCCESS", successPreference);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(importInFlight).toBe(true);
    expect(executor).toHaveBeenCalledTimes(1); // confirms the gap: power ran during import
  });

  it("gate wiring defers power while an import is in flight and runs when idle", async () => {
    vi.useFakeTimers();
    const executor = vi.fn(async () => undefined);
    let state: ActivityState = { ...IDLE, backgroundWork: true };
    const scheduler = new PostSuccessPowerScheduler({
      executor,
      countdownSeconds: 2,
      isBusy: () => activityBlockReason(state) !== undefined,
    });
    scheduler.notifySuccess("RENDER_SUCCESS", successPreference);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(executor).not.toHaveBeenCalled();
    expect(scheduler.status()).toMatchObject({ state: "CANCELLED" });

    state = IDLE;
    scheduler.notifySuccess("RENDER_SUCCESS", successPreference);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(executor).toHaveBeenCalledTimes(1);
  });
});
