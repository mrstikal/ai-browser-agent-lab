import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentCompatibilityError,
  invalidateAgentCompatibility,
  loadAgentCompatibility,
  parseAgentCompatibility,
  saveAgentCompatibility,
  type AgentCompatibilityRecord,
} from "../src/server/agent-compatibility";
import { Storage } from "../src/server/storage";

const tempDirs: string[] = [];

async function makeStorage(): Promise<Storage> {
  const base = await mkdtemp(join(tmpdir(), "ai-browser-lab-compat-"));
  tempDirs.push(base);
  return new Storage(join(base, "data"));
}

const record: AgentCompatibilityRecord = {
  version: 1,
  modelId: "openrouter/openai/gpt-5.6-luna",
  sdkVersion: "0.1.0",
  origin: "http://127.0.0.1:3000",
  verifiedAt: "2026-10-24T00:00:00.000Z",
  vision: "unverified",
};

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("agent compatibility record", () => {
  it("round-trips and invalidates without touching other files", async () => {
    const storage = await makeStorage();
    expect(await loadAgentCompatibility(storage)).toBeUndefined();
    await saveAgentCompatibility(storage, record);
    expect(await loadAgentCompatibility(storage)).toEqual(record);
    await storage.writeFile(["images", "keep.png"], "keep");
    expect(await invalidateAgentCompatibility(storage)).toBe(true);
    expect(await loadAgentCompatibility(storage)).toBeUndefined();
    expect(await storage.readFile(["images", "keep.png"])).toEqual(
      Buffer.from("keep"),
    );
  });

  it("downgrades observed vision without transport proof", () => {
    expect(
      parseAgentCompatibility({ ...record, vision: "observed" }),
    ).toMatchObject({ vision: "unverified" });
    expect(
      parseAgentCompatibility({
        ...record,
        vision: "observed",
        visionTransport: true,
      }),
    ).toMatchObject({ vision: "observed", visionTransport: true });
    expect(() =>
      parseAgentCompatibility({ ...record, visionTransport: false }),
    ).toThrow(AgentCompatibilityError);
  });

  it("rejects malformed, unsupported, and invalid records", async () => {
    const storage = await makeStorage();
    await storage.writeFile(["agent-compatibility.json"], "{bad");
    await expect(loadAgentCompatibility(storage)).rejects.toThrow(
      AgentCompatibilityError,
    );
    expect(() =>
      parseAgentCompatibility({ ...record, version: 2 }),
    ).toThrow(AgentCompatibilityError);
    expect(() =>
      parseAgentCompatibility({ ...record, vision: "guessed" }),
    ).toThrow(AgentCompatibilityError);
    expect(() =>
      parseAgentCompatibility({ ...record, verifiedAt: "not-a-date" }),
    ).toThrow(AgentCompatibilityError);
    expect(() =>
      parseAgentCompatibility({ ...record, modelId: "x".repeat(501) }),
    ).toThrow(AgentCompatibilityError);
    expect(() =>
      parseAgentCompatibility({ ...record, modelId: 42 }),
    ).toThrow(AgentCompatibilityError);
    expect(() =>
      parseAgentCompatibility({ ...record, origin: null }),
    ).toThrow(AgentCompatibilityError);
  });
});
