import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CredentialError,
  deleteOpenRouterKey,
  getKeyStatus,
  getOpenRouterKey,
  loadOpenRouterKey,
  OPENROUTER_KEY_SEGMENTS,
  resetCredentialHolderForTests,
  setOpenRouterKey,
} from "../src/server/credentials";
import {
  beginPaidOperation,
  endPaidOperation,
  PaidOperationActiveError,
  resetPaidOperationsForTests,
} from "../src/server/paid-operation";
import { Storage, StoragePathError } from "../src/server/storage";

const tempDirs: string[] = [];

async function makeDataDir(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "ai-browser-lab-credentials-"));
  tempDirs.push(base);
  return join(base, "data");
}

function envFor(dataDir: string): Record<string, string> {
  return { DATA_DIR: dataDir };
}

function waitForOutput(
  child: ChildProcess,
  pattern: RegExp,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    let settled = false;
    const finish = (error: Error | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolve(output);
    };
    const onData = (chunk: Buffer | string) => {
      output += chunk.toString();
      if (pattern.test(output)) finish(undefined);
    };
    const onExit = (code: number | null) => {
      finish(
        new Error(
          `Child exited before matching ${pattern} (code ${String(code)}): ${output}`,
        ),
      );
    };
    const timer = setTimeout(
      () => finish(new Error(`Timed out waiting for ${pattern}: ${output}`)),
      timeoutMs,
    );
    child.stdout?.on("data", onData);
    child.once("exit", onExit);
  });
}

async function childKeyStatus(dataDir: string): Promise<unknown> {
  const moduleUrl = new URL("../src/server/credentials.ts", import.meta.url).href;
  const code = `
    import { getKeyStatus } from ${JSON.stringify(moduleUrl)};
    console.log("STATUS " + JSON.stringify(await getKeyStatus()));
  `;
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", code],
    {
      cwd: process.cwd(),
      env: { ...process.env, DATA_DIR: dataDir },
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  try {
    const output = await waitForOutput(child, /STATUS /, 15_000);
    const match = /STATUS (\{.*\})/.exec(output);
    if (!match?.[1]) throw new Error(`Missing status JSON: ${output}`);
    return JSON.parse(match[1]) as unknown;
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  }
}

afterEach(async () => {
  resetCredentialHolderForTests();
  resetPaidOperationsForTests();
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("credential lifecycle", () => {
  it("keeps a Remember-off key in process memory only", async () => {
    const dataDir = await makeDataDir();
    const env = envFor(dataDir);
    resetCredentialHolderForTests();
    expect(await getKeyStatus(env)).toEqual({ keyAvailable: false, source: null });

    const status = await setOpenRouterKey("sk-or-v1-memory-key", {
      remember: false,
      env,
    });
    expect(status).toEqual({ keyAvailable: true, source: "memory" });
    expect(getOpenRouterKey()).toBe("sk-or-v1-memory-key");
    expect(await loadOpenRouterKey(env)).toBe("sk-or-v1-memory-key");

    const storage = new Storage(dataDir);
    expect(await storage.readFile(["secrets", "openrouter-key"])).toBeUndefined();
    expect(JSON.stringify(status)).not.toContain("sk-or-v1-memory-key");
  });

  it("stores a Remember-on key in a private 0600 file", async () => {
    const dataDir = await makeDataDir();
    const env = envFor(dataDir);
    resetCredentialHolderForTests();

    const status = await setOpenRouterKey("sk-or-v1-file-key", {
      remember: true,
      env,
    });
    expect(status).toEqual({ keyAvailable: true, source: "file" });

    const storage = new Storage(dataDir);
    const path = storage.path(OPENROUTER_KEY_SEGMENTS);
    expect(await readFile(path, "utf8")).toBe("sk-or-v1-file-key");
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await stat(storage.path(["secrets"]))).mode & 0o700).toBe(0o700);
    }
  });

  it("removes an old disk copy when a remembered key is replaced without Remember", async () => {
    const dataDir = await makeDataDir();
    const env = envFor(dataDir);
    resetCredentialHolderForTests();

    await setOpenRouterKey("sk-or-v1-remembered", { remember: true, env });
    const storage = new Storage(dataDir);
    expect(
      await storage.readFile(["secrets", "openrouter-key"]),
    ).toBeDefined();

    const status = await setOpenRouterKey("sk-or-v1-session", {
      remember: false,
      env,
    });
    expect(status).toEqual({ keyAvailable: true, source: "memory" });
    expect(await storage.readFile(["secrets", "openrouter-key"])).toBeUndefined();
    expect(getOpenRouterKey()).toBe("sk-or-v1-session");
  });

  it("deletes the key from memory and disk idempotently", async () => {
    const dataDir = await makeDataDir();
    const env = envFor(dataDir);
    resetCredentialHolderForTests();

    await setOpenRouterKey("sk-or-v1-delete-me", { remember: true, env });
    expect(await deleteOpenRouterKey({ env })).toEqual({
      keyAvailable: false,
      source: null,
    });
    expect(getOpenRouterKey()).toBeUndefined();
    const storage = new Storage(dataDir);
    expect(await storage.readFile(["secrets", "openrouter-key"])).toBeUndefined();
    expect(await deleteOpenRouterKey({ env })).toEqual({
      keyAvailable: false,
      source: null,
    });
  });

  it("loads a remembered key from disk for a replacement process", async () => {
    const dataDir = await makeDataDir();
    const env = envFor(dataDir);
    resetCredentialHolderForTests();

    const storage = new Storage(dataDir);
    await storage.writeFile(["secrets", "openrouter-key"], "  sk-or-v1-from-disk\n");
    resetCredentialHolderForTests();

    expect(await loadOpenRouterKey(env)).toBe("sk-or-v1-from-disk");
    expect(await getKeyStatus(env)).toEqual({
      keyAvailable: true,
      source: "file",
    });
  });

  it("does not let an in-flight disk load overwrite a replacement", async () => {
    const dataDir = await makeDataDir();
    const env = envFor(dataDir);
    const storage = new Storage(dataDir);
    await storage.writeFile(["secrets", "openrouter-key"], "sk-or-v1-old-disk");
    resetCredentialHolderForTests();

    let release!: (value: Buffer | undefined) => void;
    const gate = new Promise<Buffer | undefined>((resolve) => {
      release = resolve;
    });
    const spy = vi
      .spyOn(Storage.prototype, "readFile")
      .mockImplementation((() => gate) as never);
    try {
      const statusPromise = getKeyStatus(env);
      await setOpenRouterKey("sk-or-v1-replacement", { remember: false, env });
      release(Buffer.from("sk-or-v1-old-disk"));
      await statusPromise;
    } finally {
      spy.mockRestore();
    }

    expect(getOpenRouterKey()).toBe("sk-or-v1-replacement");
    expect(await getKeyStatus(env)).toEqual({
      keyAvailable: true,
      source: "memory",
    });
  });

  it("sweeps crash-leftover key temp files on write, load, and delete", async () => {
    const dataDir = await makeDataDir();
    const env = envFor(dataDir);
    const storage = new Storage(dataDir);
    await storage.writeFile(["secrets", ".openrouter-key.abc123.tmp"], "leftover");
    resetCredentialHolderForTests();

    await setOpenRouterKey("sk-or-v1-clean", { remember: true, env });
    expect(
      await storage.readFile(["secrets", ".openrouter-key.abc123.tmp"]),
    ).toBeUndefined();

    await storage.writeFile(["secrets", ".openrouter-key.def456.tmp"], "leftover");
    await deleteOpenRouterKey({ env });
    expect(
      await storage.readFile(["secrets", ".openrouter-key.def456.tmp"]),
    ).toBeUndefined();
  });

  it("does not sweep temp files from read-only status callers", async () => {
    const dataDir = await makeDataDir();
    const env = envFor(dataDir);
    const storage = new Storage(dataDir);
    await storage.writeFile(["secrets", ".openrouter-key.readonly.tmp"], "leftover");
    resetCredentialHolderForTests();

    await getKeyStatus(env, { sweepTemps: false });
    expect(
      await storage.readFile(["secrets", ".openrouter-key.readonly.tmp"]),
    ).toEqual(Buffer.from("leftover"));

    resetCredentialHolderForTests();
    await getKeyStatus(env);
    expect(
      await storage.readFile(["secrets", ".openrouter-key.readonly.tmp"]),
    ).toBeUndefined();
  });

  it("exposes the crash window between invalidation and the key write", async () => {
    const dataDir = await makeDataDir();
    const env = envFor(dataDir);
    const storage = new Storage(dataDir);
    resetCredentialHolderForTests();

    await setOpenRouterKey("sk-or-v1-old", { remember: true, env });
    await storage.writeJson(["agent-compatibility.json"], { model: "m" });

    const failing = new Storage(dataDir);
    vi.spyOn(failing, "writeFile").mockRejectedValueOnce(
      new Error("simulated crash"),
    );
    await expect(
      setOpenRouterKey("sk-or-v1-new", {
        remember: true,
        env,
        storage: failing,
      }),
    ).rejects.toThrow("simulated crash");

    expect(await storage.readFile(["agent-compatibility.json"])).toBeUndefined();
    expect(getOpenRouterKey()).toBe("sk-or-v1-old");
    expect(await storage.readFile(["secrets", "openrouter-key"])).toEqual(
      Buffer.from("sk-or-v1-old"),
    );
  });

  it("fails closed on a malformed stored key and allows deletion", async () => {
    const dataDir = await makeDataDir();
    const env = envFor(dataDir);
    const storage = new Storage(dataDir);
    await storage.writeFile(["secrets", "openrouter-key"], "short");
    resetCredentialHolderForTests();

    await expect(getKeyStatus(env)).rejects.toThrow(CredentialError);
    expect(await deleteOpenRouterKey({ env })).toEqual({
      keyAvailable: false,
      source: null,
    });
    expect(await storage.readFile(["secrets", "openrouter-key"])).toBeUndefined();
  });

  it("retains a memory key across module reloads but not across processes", async () => {
    const dataDir = await makeDataDir();
    const env = envFor(dataDir);
    resetCredentialHolderForTests();

    await setOpenRouterKey("sk-or-v1-hmr", { remember: false, env });
    vi.resetModules();
    const reloaded = await import("../src/server/credentials");
    expect(reloaded.getOpenRouterKey()).toBe("sk-or-v1-hmr");

    expect(await childKeyStatus(dataDir)).toEqual({
      keyAvailable: false,
      source: null,
    });

    await setOpenRouterKey("sk-or-v1-remembered-child", {
      remember: true,
      env,
    });
    expect(await childKeyStatus(dataDir)).toEqual({
      keyAvailable: true,
      source: "file",
    });
  }, 30_000);

  it("refuses replacements and deletion during an active paid operation", async () => {
    const dataDir = await makeDataDir();
    const env = envFor(dataDir);
    resetCredentialHolderForTests();
    await setOpenRouterKey("sk-or-v1-before-paid", { remember: true, env });

    beginPaidOperation("image-job-1", "image");
    await expect(
      setOpenRouterKey("sk-or-v1-during-paid", { remember: false, env }),
    ).rejects.toThrow(PaidOperationActiveError);
    await expect(deleteOpenRouterKey({ env })).rejects.toThrow(
      PaidOperationActiveError,
    );
    expect(getOpenRouterKey()).toBe("sk-or-v1-before-paid");

    endPaidOperation("image-job-1");
    await setOpenRouterKey("sk-or-v1-after-paid", { remember: false, env });
    expect(getOpenRouterKey()).toBe("sk-or-v1-after-paid");
  });

  it("holds the paid exclusion across async compatibility invalidation", async () => {
    const dataDir = await makeDataDir();
    const env = envFor(dataDir);
    resetCredentialHolderForTests();
    const base = new Storage(dataDir);
    let releaseDelete: (() => void) | undefined;
    const deleteGate = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    const slowStorage = new Proxy(base, {
      get(target, property) {
        if (property === "deleteFile") {
          return async (segments: Parameters<Storage["deleteFile"]>[0]) => {
            await deleteGate;
            return target.deleteFile(segments);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Storage;

    const pending = setOpenRouterKey("sk-or-v1-race", {
      remember: false,
      env,
      storage: slowStorage,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(() => beginPaidOperation("race-paid", "image")).toThrow(
      PaidOperationActiveError,
    );
    releaseDelete?.();
    await pending;
    expect(getOpenRouterKey()).toBe("sk-or-v1-race");
  });

  it("invalidates model verification before changing the key and aborts on failure", async () => {
    const dataDir = await makeDataDir();
    const env = envFor(dataDir);
    const storage = new Storage(dataDir);
    resetCredentialHolderForTests();

    await storage.writeJson(["agent-compatibility.json"], {
      model: "openrouter/openai/gpt-5.6-luna",
    });
    await setOpenRouterKey("sk-or-v1-first-key", { remember: true, env });
    expect(
      await storage.readFile(["agent-compatibility.json"]),
    ).toBeUndefined();

    await mkdir(storage.path(["agent-compatibility.json"]));
    await expect(
      setOpenRouterKey("sk-or-v1-second-key", { remember: true, env }),
    ).rejects.toThrow(StoragePathError);
    expect(getOpenRouterKey()).toBe("sk-or-v1-first-key");
    expect(
      await storage.readFile(["secrets", "openrouter-key"]),
    ).toEqual(Buffer.from("sk-or-v1-first-key"));

    await expect(deleteOpenRouterKey({ env })).rejects.toThrow(
      StoragePathError,
    );
    expect(getOpenRouterKey()).toBe("sk-or-v1-first-key");

    await rm(storage.path(["agent-compatibility.json"]), {
      recursive: true,
      force: true,
    });
    await deleteOpenRouterKey({ env });
    expect(getOpenRouterKey()).toBeUndefined();
  });

  it("keeps the previous key when the disk write fails", async () => {
    const dataDir = await makeDataDir();
    const env = envFor(dataDir);
    const storage = new Storage(dataDir);
    resetCredentialHolderForTests();

    await setOpenRouterKey("sk-or-v1-stable", { remember: false, env });
    await mkdir(storage.path(["secrets", "openrouter-key"]), {
      recursive: true,
    });

    await expect(
      setOpenRouterKey("sk-or-v1-cannot-write", { remember: true, env }),
    ).rejects.toThrow();
    expect(getOpenRouterKey()).toBe("sk-or-v1-stable");
  });
});
