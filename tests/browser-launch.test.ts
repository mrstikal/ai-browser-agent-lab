import { describe, expect, it } from "vitest";
import {
  displayProblem,
  isLaunchFailure,
  withLaunchGuidance,
} from "../scripts/browser-launch";

describe("browser launch guidance", () => {
  it("only requires a display for non-headless linux runs", () => {
    expect(displayProblem({ headless: true, platform: "linux" })).toBeNull();
    expect(
      displayProblem({
        headless: false,
        platform: "linux",
        display: ":0",
      }),
    ).toBeNull();
    expect(
      displayProblem({
        headless: false,
        platform: "linux",
        waylandDisplay: "wayland-0",
      }),
    ).toBeNull();
    expect(
      displayProblem({ headless: false, platform: "darwin" }),
    ).toBeNull();
    const problem = displayProblem({ headless: false, platform: "linux" });
    expect(problem).toContain("DISPLAY and WAYLAND_DISPLAY are unset");
    expect(problem).toContain("WSLg");
    expect(problem).toContain("--headless");
  });

  it("recognises launch failures and augments them with hints", () => {
    expect(isLaunchFailure("Chrome exited before exposing CDP.")).toBe(true);
    expect(isLaunchFailure("Chrome not found")).toBe(true);
    expect(isLaunchFailure("Invalid API key")).toBe(false);

    const guided = withLaunchGuidance(new Error("Chrome not found"), {
      headless: false,
    });
    expect(guided.message).toContain("Install Google Chrome or Chromium");
    expect(guided.message).toContain("rerun with --headless");

    const headlessGuidance = withLaunchGuidance(
      new Error("Chrome exited before exposing CDP."),
      { headless: true },
    );
    expect(headlessGuidance.message).toContain(
      "check that Chrome can start at all",
    );

    const other = new Error("Invalid API key");
    expect(withLaunchGuidance(other, { headless: false })).toBe(other);
  });
});
