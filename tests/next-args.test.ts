import { describe, expect, it } from "vitest";
import { buildNextArgs, nextLaunchTarget } from "../scripts/next-args";
import { resolveAppConfig } from "../src/server/config";

describe("next launch arguments", () => {
  it("binds dev and start to the configured loopback host and port", () => {
    const config = resolveAppConfig({ APP_ORIGIN: "http://127.0.0.1:4123" });
    expect(buildNextArgs("dev", config)).toEqual([
      "dev",
      "--hostname",
      "127.0.0.1",
      "--port",
      "4123",
    ]);
    expect(buildNextArgs("start", config)).toEqual([
      "start",
      "--hostname",
      "127.0.0.1",
      "--port",
      "4123",
    ]);
    expect(nextLaunchTarget("start", config)).toBe(
      " on http://127.0.0.1:4123 (bind 127.0.0.1:4123)",
    );
  });

  it("uses the loopback bind address for localhost and IPv6 origins", () => {
    expect(
      buildNextArgs(
        "dev",
        resolveAppConfig({ APP_ORIGIN: "http://localhost:4123" }),
      ),
    ).toEqual(["dev", "--hostname", "127.0.0.1", "--port", "4123"]);
    expect(
      buildNextArgs(
        "dev",
        resolveAppConfig({ APP_ORIGIN: "http://[::1]:4123" }),
      ),
    ).toEqual(["dev", "--hostname", "::1", "--port", "4123"]);
  });

  it("does not pass bind flags to the build command", () => {
    const config = resolveAppConfig({ APP_ORIGIN: "http://127.0.0.1:4123" });
    expect(buildNextArgs("build", config)).toEqual(["build"]);
    expect(nextLaunchTarget("build", config)).toBe("");
  });
});
