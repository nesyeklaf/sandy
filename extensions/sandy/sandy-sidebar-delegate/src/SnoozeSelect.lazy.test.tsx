// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { countDateTimeFormats } from "./test-date-format-counter";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SnoozeSelect } from "./SnoozeSelect";
import { parseConfiguredSnoozePresets } from "./lifecycle";

afterEach(cleanup);

const presets = parseConfiguredSnoozePresets("1h, tomorrow@09:00");

describe("SnoozeSelect while closed", () => {
  it("formats no dates and resolves no presets until the menu opens", () => {
    const construct = countDateTimeFormats();
    try {
      render(
        <SnoozeSelect label="Snooze thread" snoozePresets={presets} triggerClassName="" onSnooze={() => {}} />,
      );
      expect(construct.count()).toBe(0);
      expect(screen.queryByRole("option")).toBeNull();

      fireEvent.keyDown(screen.getByRole("combobox", { name: "Snooze thread" }), { key: "Enter" });
      expect(screen.getAllByRole("option").map((option) => option.textContent)).toContain("1 hour");
      expect(construct.count()).toBeGreaterThan(0);
    } finally {
      construct.restore();
    }
  });

  it("builds no picker dialog content before Pick date & time is chosen", () => {
    render(<SnoozeSelect label="Snooze thread" snoozePresets={presets} triggerClassName="" onSnooze={() => {}} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Snooze thread" }), { key: "Enter" });
    fireEvent.click(screen.getByRole("option", { name: /Pick date/ }));
    expect(screen.getByRole("dialog", { name: "Snooze until" })).toBeTruthy();
  });
});
