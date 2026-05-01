import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { SaveIndicator } from "./TopBar";

describe("SaveIndicator", () => {
  it("reserves slot space when transitioning idle → saving → idle (no layout shift)", () => {
    const { rerender } = render(<SaveIndicator status="idle" />);

    const idleSlot = screen.getByTestId("save-indicator");
    // While idle the indicator stays mounted as an empty inline-flex slot,
    // so the surrounding TopBar layout doesn't reflow when a save kicks off.
    expect(idleSlot).toBeInTheDocument();
    expect(idleSlot).toHaveAttribute("data-status", "idle");
    expect(idleSlot).toHaveStyle({ opacity: "0" });
    expect(idleSlot).toHaveAttribute("aria-hidden", "true");

    rerender(<SaveIndicator status="saving" />);
    const savingSlot = screen.getByTestId("save-indicator");
    expect(savingSlot).toHaveAttribute("data-status", "saving");
    expect(savingSlot).toHaveStyle({ opacity: "1" });
    expect(savingSlot).toHaveAttribute("aria-hidden", "false");
    expect(savingSlot).toHaveTextContent("Saving…");

    // Returning to idle — slot must persist with the most recent label so the
    // width stays reserved and the fade-out reads as a single element.
    rerender(<SaveIndicator status="idle" />);
    const idleAfter = screen.getByTestId("save-indicator");
    expect(idleAfter).toHaveAttribute("data-status", "idle");
    expect(idleAfter).toHaveStyle({ opacity: "0" });
    expect(idleAfter).toHaveAttribute("aria-hidden", "true");
    // Last non-idle content stays mounted so the slot keeps its measured size.
    expect(idleAfter).toHaveTextContent("Saving…");
  });

  it("shows the 'Saved' label and toggles aria-hidden off when status is 'saved'", () => {
    render(<SaveIndicator status="saved" />);
    const slot = screen.getByTestId("save-indicator");

    expect(slot).toHaveAttribute("data-status", "saved");
    expect(slot).toHaveAttribute("aria-hidden", "false");
    expect(slot).toHaveStyle({ opacity: "1" });
    expect(slot).toHaveTextContent("Saved");
  });

  it("shows the 'Save failed' label when status is 'error'", () => {
    render(<SaveIndicator status="error" />);
    const slot = screen.getByTestId("save-indicator");

    expect(slot).toHaveAttribute("data-status", "error");
    expect(slot).toHaveAttribute("aria-hidden", "false");
    expect(slot).toHaveStyle({ opacity: "1" });
    expect(slot).toHaveTextContent("Save failed");
  });

  it("flips aria-hidden back to true when leaving a non-idle state", () => {
    const { rerender } = render(<SaveIndicator status="error" />);
    expect(screen.getByTestId("save-indicator")).toHaveAttribute(
      "aria-hidden",
      "false",
    );

    rerender(<SaveIndicator status="idle" />);
    expect(screen.getByTestId("save-indicator")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });
});
