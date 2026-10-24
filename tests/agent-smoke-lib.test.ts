import { describe, expect, it } from "vitest";
import {
  AgentSmokeUsageError,
  canStampCompatibility,
  containsImageContent,
  headingIsShop,
  parseAgentSmokeArgs,
  redactText,
} from "../scripts/agent-smoke-lib";

describe("agent smoke arguments", () => {
  it("defaults to a zero-observation preflight", () => {
    expect(parseAgentSmokeArgs([])).toEqual({
      live: false,
      approvePaid: false,
      approvals: [],
      headless: false,
      help: false,
      keySource: "auto",
      model: null,
    });
  });

  it("parses explicit live, consent, key source, and model flags", () => {
    expect(
      parseAgentSmokeArgs([
        "--live",
        "--approve-paid",
        "--approve-observation=1",
        "--approve-observation=2",
        "--headless",
        "--key-source=tty",
        "--model=openrouter/openai/gpt-5.6-luna",
      ]),
    ).toMatchObject({
      live: true,
      approvePaid: true,
      approvals: [1, 2],
      headless: true,
      keySource: "tty",
      model: "openrouter/openai/gpt-5.6-luna",
    });
    expect(() => parseAgentSmokeArgs(["--unknown"])).toThrow(
      AgentSmokeUsageError,
    );
    expect(() => parseAgentSmokeArgs(["--key-source=env"])).toThrow(
      AgentSmokeUsageError,
    );
    expect(() => parseAgentSmokeArgs(["--approve-observation=3"])).toThrow(
      AgentSmokeUsageError,
    );
  });
});

describe("agent smoke evidence", () => {
  it("detects image content only from structured content parts", () => {
    expect(
      containsImageContent({
        content: [{ type: "text", text: "ok" }, { type: "image", data: "..." }],
      }),
    ).toBe(true);
    expect(
      containsImageContent({ content: [{ type: "text", text: "image" }] }),
    ).toBe(false);
    expect(containsImageContent({ totalTokens: 100 })).toBe(false);
    expect(containsImageContent(null)).toBe(false);
  });

  it("accepts only the exact Shop heading", () => {
    expect(headingIsShop({ heading: "Shop" })).toBe(true);
    expect(headingIsShop({ heading: "  Shop  " })).toBe(true);
    expect(headingIsShop({ heading: "Shop | AI Browser Agent Lab" })).toBe(false);
    expect(headingIsShop({ heading: 42 })).toBe(false);
    expect(headingIsShop(null)).toBe(false);
  });

  it("redacts known and key-shaped values from report text", () => {
    expect(redactText("bad sk-or-v1-abc123 and secret", "secret")).toBe(
      "bad [redacted] and [redacted]",
    );
  });

  it("stamps only for the app key, matching model, success, and blocked domains", () => {
    const eligible = {
      headingOk: true,
      domainPolicyBlocked: true,
      keySource: "app" as const,
      usedRememberedKey: true,
      modelMatchesSettings: true,
      currentKeyStillMatches: true,
      currentModelStillMatches: true,
    };
    expect(canStampCompatibility(eligible)).toBe(true);
    for (const override of [
      { headingOk: false },
      { domainPolicyBlocked: false },
      { keySource: "tty" as const },
      { usedRememberedKey: false },
      { modelMatchesSettings: false },
      { currentKeyStillMatches: false },
      { currentModelStillMatches: false },
    ]) {
      expect(canStampCompatibility({ ...eligible, ...override })).toBe(false);
    }
  });
});
