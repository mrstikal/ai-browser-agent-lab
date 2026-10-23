import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, LockHeldError, readLockMetadata } from "../src/server/lock";
import { Storage } from "../src/server/storage";

const tempDirs: string[] = [];
let release: (() => Promise<void>) | undefined;

async function makeDataDir(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "ai-browser-lab-server-lock-"));
  tempDirs.push(base);
  return join(base, "data");
}

afterEach(async () => {
  if (release) {
    await release().catch(() => undefined);
    release = undefined;
  }
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("server lock", () => {
  it("holds one lock per data directory and reports health ownership", async () => {
    const dataDir = await makeDataDir();
    const mod = await import("../src/server/server-lock");
    release = mod.releaseServerLock;

    const lock = await mod.ensureServerLock({ DATA_DIR: dataDir });
    expect(lock.path).toBe(join(dataDir, ".server.lock"));
    expect(lock.ownerId.length).toBeGreaterThan(0);
    expect(await mod.isServerLockHeld({ DATA_DIR: dataDir })).toBe(true);
    expect(lock.metadata).toEqual(await readLockMetadata(lock.path));

    expect(await mod.ensureServerLock({ DATA_DIR: dataDir })).toBe(lock);

    await expect(
      acquireLock(new Storage(dataDir), [".server.lock"], { kind: "server" }),
    ).rejects.toThrow(LockHeldError);

    await mod.releaseServerLock();
    expect(await mod.isServerLockHeld({ DATA_DIR: dataDir })).toBe(false);
    expect(await readLockMetadata(lock.path)).toBeUndefined();

    const again = await mod.ensureServerLock({ DATA_DIR: dataDir });
    expect(again.ownerId).not.toBe(lock.ownerId);
    expect(await mod.isServerLockHeld({ DATA_DIR: dataDir })).toBe(true);
  });

  it("keeps the same in-process handle across module reloads", async () => {
    const dataDir = await makeDataDir();
    vi.resetModules();
    const first = await import("../src/server/server-lock");
    release = first.releaseServerLock;
    const lock = await first.ensureServerLock({ DATA_DIR: dataDir });

    vi.resetModules();
    const second = await import("../src/server/server-lock");
    release = second.releaseServerLock;
    const reloaded = await second.ensureServerLock({ DATA_DIR: dataDir });

    expect(reloaded).toBe(lock);
    expect(await second.isServerLockHeld({ DATA_DIR: dataDir })).toBe(true);
    expect((await readFile(lock.path, "utf8")).match(/"ownerId"/g)).toHaveLength(1);
  });

  it("refuses to switch data directories inside one process", async () => {
    const firstDir = await makeDataDir();
    const secondDir = await makeDataDir();
    const mod = await import("../src/server/server-lock");
    release = mod.releaseServerLock;

    await mod.ensureServerLock({ DATA_DIR: firstDir });
    await expect(
      mod.ensureServerLock({ DATA_DIR: secondDir }),
    ).rejects.toMatchObject({ name: "ServerLockError" });
  });

  it("reports unhealthy and refuses release when the lock is replaced", async () => {
    const dataDir = await makeDataDir();
    const mod = await import("../src/server/server-lock");
    release = mod.releaseServerLock;
    const lock = await mod.ensureServerLock({ DATA_DIR: dataDir });

    const replacement = {
      ...lock.metadata,
      ownerId: "replacement-owner",
    };
    await writeFile(lock.path, `${JSON.stringify(replacement, null, 2)}\n`);

    expect(await mod.isServerLockHeld({ DATA_DIR: dataDir })).toBe(false);
    await expect(
      mod.ensureServerLock({ DATA_DIR: dataDir }),
    ).rejects.toMatchObject({ name: "ServerLockError" });
    await expect(mod.releaseServerLock()).rejects.toMatchObject({
      name: "LockOwnershipError",
    });
    expect(await readLockMetadata(lock.path)).toMatchObject({
      ownerId: "replacement-owner",
    });
  });
});
