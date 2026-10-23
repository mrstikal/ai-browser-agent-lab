import { describe, expect, it } from "vitest";
import { HEALTH_MARKER, HEALTH_PAYLOAD } from "../src/lib/health";

describe("health payload", () => {
  it("uses a fixed application marker", () => {
    expect(HEALTH_MARKER).toBe("ai-browser-agent-lab");
    expect(HEALTH_PAYLOAD).toEqual({
      ok: true,
      app: "ai-browser-agent-lab",
    });
  });
});
