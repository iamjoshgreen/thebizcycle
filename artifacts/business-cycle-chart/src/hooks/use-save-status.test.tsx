import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useSaveStatus } from "./use-persisted-settings";

const SAVED_LINGER_MS = 1500;
const ERROR_LINGER_MS = 4000;

describe("useSaveStatus", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts in 'idle' before any save has happened", () => {
    const { result } = renderHook(
      ({ isSaving, saveError }: { isSaving: boolean; saveError: boolean }) =>
        useSaveStatus(isSaving, saveError),
      { initialProps: { isSaving: false, saveError: false } },
    );

    expect(result.current).toBe("idle");
  });

  it("transitions to 'saving' on the rising edge of isSaving", () => {
    const { result, rerender } = renderHook(
      ({ isSaving, saveError }: { isSaving: boolean; saveError: boolean }) =>
        useSaveStatus(isSaving, saveError),
      { initialProps: { isSaving: false, saveError: false } },
    );

    expect(result.current).toBe("idle");

    rerender({ isSaving: true, saveError: false });
    expect(result.current).toBe("saving");
  });

  it("falling edge with no error → 'saved' that lingers then resets to 'idle'", () => {
    const { result, rerender } = renderHook(
      ({ isSaving, saveError }: { isSaving: boolean; saveError: boolean }) =>
        useSaveStatus(isSaving, saveError),
      { initialProps: { isSaving: true, saveError: false } },
    );

    expect(result.current).toBe("saving");

    rerender({ isSaving: false, saveError: false });
    expect(result.current).toBe("saved");

    // Just before the linger expires, still 'saved'.
    act(() => {
      vi.advanceTimersByTime(SAVED_LINGER_MS - 1);
    });
    expect(result.current).toBe("saved");

    // After the linger expires, falls back to 'idle'.
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe("idle");
  });

  it("falling edge with error → 'error' that lingers for the longer error duration", () => {
    const { result, rerender } = renderHook(
      ({ isSaving, saveError }: { isSaving: boolean; saveError: boolean }) =>
        useSaveStatus(isSaving, saveError),
      { initialProps: { isSaving: true, saveError: false } },
    );

    rerender({ isSaving: false, saveError: true });
    expect(result.current).toBe("error");

    // The 'saved' linger has long passed but we're still in 'error' because
    // the error linger is longer.
    act(() => {
      vi.advanceTimersByTime(SAVED_LINGER_MS + 100);
    });
    expect(result.current).toBe("error");

    // Once the full error linger passes, we fall back to 'idle'.
    act(() => {
      vi.advanceTimersByTime(ERROR_LINGER_MS - SAVED_LINGER_MS - 100);
    });
    expect(result.current).toBe("idle");
  });

  it("rapid retry while in 'error' linger overrides the pending fallback to 'idle'", () => {
    const { result, rerender } = renderHook(
      ({ isSaving, saveError }: { isSaving: boolean; saveError: boolean }) =>
        useSaveStatus(isSaving, saveError),
      { initialProps: { isSaving: true, saveError: false } },
    );

    // First save fails.
    rerender({ isSaving: false, saveError: true });
    expect(result.current).toBe("error");

    // Partway through the error linger the user (or auto-retry) fires another
    // save — the indicator should immediately switch to 'saving', not stay on
    // 'error' nor flicker to 'idle'.
    act(() => {
      vi.advanceTimersByTime(500);
    });
    rerender({ isSaving: true, saveError: false });
    expect(result.current).toBe("saving");

    // The retry succeeds. We should now show 'saved', not 'error', and the
    // pending error→idle timer from the first failure must not have leaked
    // through and stomped on this new state.
    rerender({ isSaving: false, saveError: false });
    expect(result.current).toBe("saved");

    // The previous error timer was scheduled to fire at t≈4000ms after the
    // first failure. We've consumed 500ms before the retry; advancing by
    // ERROR_LINGER_MS now would cross that boundary if it were still alive.
    act(() => {
      vi.advanceTimersByTime(ERROR_LINGER_MS);
    });
    // Saved linger is shorter, so by now we expect 'idle' — and crucially
    // not 'idle' that was set early by a leaked error timer.
    expect(result.current).toBe("idle");
  });

  it("a new 'saving' overrides any pending 'saved' linger", () => {
    const { result, rerender } = renderHook(
      ({ isSaving, saveError }: { isSaving: boolean; saveError: boolean }) =>
        useSaveStatus(isSaving, saveError),
      { initialProps: { isSaving: true, saveError: false } },
    );

    // First save settles successfully.
    rerender({ isSaving: false, saveError: false });
    expect(result.current).toBe("saved");

    // Mid-linger another save begins. The indicator should report 'saving'
    // without waiting for the saved linger to expire.
    act(() => {
      vi.advanceTimersByTime(200);
    });
    rerender({ isSaving: true, saveError: false });
    expect(result.current).toBe("saving");

    // Even after the original saved-linger window would have closed, we
    // remain on 'saving' because the new save is still in flight — i.e. the
    // stale linger timer was cleaned up.
    act(() => {
      vi.advanceTimersByTime(SAVED_LINGER_MS);
    });
    expect(result.current).toBe("saving");
  });
});
