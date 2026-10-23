import { describe, expect, it } from "vitest";
import {
  AppConfigError,
  DEFAULT_APP_ORIGIN,
  resolveAppConfig,
} from "../src/server/config";

describe("resolveAppConfig", () => {
  it("uses the default loopback origin", () => {
    expect(DEFAULT_APP_ORIGIN).toBe("http://127.0.0.1:3000");
    expect(resolveAppConfig({})).toEqual({
      origin: "http://127.0.0.1:3000",
      hostname: "127.0.0.1",
      bindHost: "127.0.0.1",
      port: 3000,
    });
  });

  it("accepts localhost with an explicit port", () => {
    expect(resolveAppConfig({ APP_ORIGIN: "http://localhost:4123" })).toEqual({
      origin: "http://localhost:4123",
      hostname: "localhost",
      bindHost: "127.0.0.1",
      port: 4123,
    });
  });

  it("accepts IPv6 loopback and strips brackets for binding", () => {
    expect(resolveAppConfig({ APP_ORIGIN: "http://[::1]:4123" })).toEqual({
      origin: "http://[::1]:4123",
      hostname: "[::1]",
      bindHost: "::1",
      port: 4123,
    });
  });

  it("keeps the bind host and port consistent with the origin", () => {
    for (const raw of [
      "http://127.0.0.1:4123",
      "http://localhost:4123",
      "http://[::1]:4123",
    ]) {
      const config = resolveAppConfig({ APP_ORIGIN: raw });
      const url = new URL(config.origin);
      expect(url.port).toBe(String(config.port));
      expect(url.hostname).toBe(config.hostname);
      expect(["127.0.0.1", "::1"]).toContain(config.bindHost);
    }
  });

  it("accepts a trailing slash as part of the origin", () => {
    expect(resolveAppConfig({ APP_ORIGIN: "http://127.0.0.1:4123/" }).origin).toBe(
      "http://127.0.0.1:4123",
    );
  });

  it("explains that a non-default port is required", () => {
    expect(() => resolveAppConfig({ APP_ORIGIN: "http://127.0.0.1:80" })).toThrow(/non-default/);
  });

  it.each([
    ["empty", ""],
    ["malformed", "not a url"],
    ["LAN address", "http://192.168.1.10:3000"],
    ["all interfaces", "http://0.0.0.0:3000"],
    ["external host", "http://example.com:3000"],
    ["https", "https://127.0.0.1:3000"],
    ["missing port", "http://127.0.0.1"],
    ["default port", "http://127.0.0.1:80"],
    ["zero port", "http://127.0.0.1:0"],
    ["out-of-range port", "http://127.0.0.1:65536"],
    ["path", "http://127.0.0.1:3000/shop"],
    ["query", "http://127.0.0.1:3000?q=test"],
    ["fragment", "http://127.0.0.1:3000#top"],
    ["credentials", "http://user:pass@127.0.0.1:3000"],
  ])("rejects a %s origin", (_label, origin) => {
    expect(() => resolveAppConfig({ APP_ORIGIN: origin })).toThrow(AppConfigError);
  });
});
