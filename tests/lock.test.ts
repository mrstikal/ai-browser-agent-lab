import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireLock,
  classifyLockOwner,
  LOCK_VERSION,
  LockHeldError,
  LockOwnershipError,
  LockUncertainError,
  readLockMetadata,
  sameOwner,
  type LockMetadata,
} from "../src/server/lock";
import {
  readBootId,
  readProcessStartTicks,
} from "../src/server/process-identity";
import { PRIVATE_FILE_MODE, Storage } from "../src/server/storage";

const tempDirs: string[] = [];

async function makeStorage(): Promise<Storage> {
  const base = await mkdtemp(join(tmpdir(), "ai-browser-lab-lock-"));
  tempDirs.push(base);
  return new Storage(join(base, "data"));
}

async function makeProcRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ai-browser-lab-lock-proc-"));
  tempDirs.push(root);
  await mkdir(join(root, "sys", "kernel", "random"), { recursive: true });
  await writeFile(join(root, "sys", "kernel", "random", "boot_id"), "test-boot\n");
  return root;
}

function statLine(pid: number, ticks: number, comm = "node"): string {
  const fields = Array.from({ length: 49 }, (_, index) =>
    index === 18 ? String(ticks) : "0",
  );
  return `${pid} (${comm}) S ${fields.join(" ")}\n`;
}

async function writeProcStat(root: string, pid: number, content: string): Promise<void> {
  await mkdir(join(root, String(pid)), { recursive: true });
  await writeFile(join(root, String(pid), "stat"), content);
}

function metadata(overrides: Partial<LockMetadata> = {}): LockMetadata {
  return {
    version: LOCK_VERSION,
    kind: "paid-job",
    ownerId: "owner-under-test",
    pid: 999,
    procStartTicks: 100,
    bootId: "test-boot",
    acquiredAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

async function writeLock(storage: Storage, value: unknown): Promise<void> {
  await storage.writeJson(["locks", "paid-job.lock"], value);
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
          `Lock holder exited before printing ${pattern} (code ${String(code)}): ${output}`,
        ),
      );
    };
    const timer = setTimeout(() => {
      finish(new Error(`Timed out waiting for ${pattern}: ${output}`));
    }, timeoutMs);
    child.stdout?.on("data", onData);
    child.once("exit", onExit);
  });
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("owner lock", () => {
  it("acquires, records owner metadata, and releases the lock", async () => {
    const storage = await makeStorage();
    const lock = await acquireLock(storage, ["locks", "paid-job.lock"], {
      kind: "paid-job",
    });

    expect(lock.metadata.pid).toBe(process.pid);
    expect(lock.metadata.kind).toBe("paid-job");
    expect(lock.metadata.bootId.length).toBeGreaterThan(0);
    expect(lock.path).toBe(join(storage.root, "locks", "paid-job.lock"));

    const stored = await readLockMetadata(lock.path);
    expect(stored).toEqual(lock.metadata);
    expect(sameOwner(stored as LockMetadata, lock.metadata)).toBe(true);
    if (process.platform !== "win32") {
      expect((await stat(lock.path)).mode & 0o777).toBe(PRIVATE_FILE_MODE);
    }

    await lock.release();
    expect(lock.isReleased()).toBe(true);
    expect(await readLockMetadata(lock.path)).toBeUndefined();
    await lock.release();
  });

  it("rejects a second owner while the first is active", async () => {
    const storage = await makeStorage();
    const first = await acquireLock(storage, ["locks", "paid-job.lock"], {
      kind: "paid-job",
    });

    await expect(
      acquireLock(storage, ["locks", "paid-job.lock"], {
        kind: "paid-job",
        ownerId: "second-owner",
      }),
    ).rejects.toMatchObject({
      name: "LockHeldError",
      owner: expect.objectContaining({ ownerId: first.ownerId }),
    });

    await first.release();
    const second = await acquireLock(storage, ["locks", "paid-job.lock"], {
      kind: "paid-job",
      ownerId: "second-owner",
    });
    expect(second.ownerId).toBe("second-owner");
    await second.release();
  });

  it("allows independent data directories", async () => {
    const first = await acquireLock(await makeStorage(), ["locks", "paid-job.lock"], {
      kind: "paid-job",
    });
    const second = await acquireLock(await makeStorage(), ["locks", "paid-job.lock"], {
      kind: "paid-job",
    });
    expect(first.path).not.toBe(second.path);
    await first.release();
    await second.release();
  });

  it("reclaims a lock whose process is gone", async () => {
    const storage = await makeStorage();
    const procRoot = await makeProcRoot();
    const currentTicks = await readProcessStartTicks(process.pid);
    if (currentTicks === undefined) throw new Error("Missing current process stat.");
    await writeProcStat(procRoot, process.pid, statLine(process.pid, currentTicks));
    await writeLock(storage, metadata({ pid: 999, procStartTicks: 1 }));

    const lock = await acquireLock(storage, ["locks", "paid-job.lock"], {
      kind: "paid-job",
      procRoot,
    });
    expect(lock.metadata.pid).toBe(process.pid);
    expect(lock.metadata.ownerId).not.toBe("owner-under-test");
    await lock.release();
  });

  it("distinguishes a reused PID from the recorded process", async () => {
    const storage = await makeStorage();
    const procRoot = await makeProcRoot();
    const currentTicks = await readProcessStartTicks(process.pid);
    if (currentTicks === undefined) throw new Error("Missing current process stat.");
    await writeProcStat(procRoot, process.pid, statLine(process.pid, currentTicks));
    await writeProcStat(procRoot, 999, statLine(999, 200));
    await writeLock(storage, metadata({ pid: 999, procStartTicks: 100 }));

    const lock = await acquireLock(storage, ["locks", "paid-job.lock"], {
      kind: "paid-job",
      procRoot,
    });
    expect(lock.metadata.pid).toBe(process.pid);
    await lock.release();
  });

  it("never reclaims an active matching process", async () => {
    const storage = await makeStorage();
    const procRoot = await makeProcRoot();
    const currentTicks = await readProcessStartTicks(process.pid);
    if (currentTicks === undefined) throw new Error("Missing current process stat.");
    await writeProcStat(procRoot, process.pid, statLine(process.pid, currentTicks));
    await writeProcStat(procRoot, 999, statLine(999, 200));
    const active = metadata({ pid: 999, procStartTicks: 200 });
    await writeLock(storage, active);
    const before = await readFile(storage.path(["locks", "paid-job.lock"]));

    await expect(
      acquireLock(storage, ["locks", "paid-job.lock"], {
        kind: "paid-job",
        procRoot,
      }),
    ).rejects.toThrow(LockHeldError);
    expect(await readFile(storage.path(["locks", "paid-job.lock"]))).toEqual(before);
  });

  it("reclaims metadata from a previous boot even if the PID is live", async () => {
    const storage = await makeStorage();
    const procRoot = await makeProcRoot();
    const currentTicks = await readProcessStartTicks(process.pid);
    if (currentTicks === undefined) throw new Error("Missing current process stat.");
    await writeProcStat(procRoot, process.pid, statLine(process.pid, currentTicks));
    await writeProcStat(procRoot, 999, statLine(999, 200));
    await writeLock(
      storage,
      metadata({ pid: 999, procStartTicks: 200, bootId: "previous-boot" }),
    );

    const status = await classifyLockOwner(
      metadata({ pid: 999, procStartTicks: 200, bootId: "previous-boot" }),
      { procRoot },
    );
    expect(status).toEqual({ state: "stale", reason: "boot-id-changed" });

    const lock = await acquireLock(storage, ["locks", "paid-job.lock"], {
      kind: "paid-job",
      procRoot,
    });
    expect(lock.metadata.bootId).toBe("test-boot");
    await lock.release();
  });

  it("waits briefly for a concurrent creator to finish writing metadata", async () => {
    const storage = await makeStorage();
    await storage.ensureDir(["locks"]);
    const path = storage.path(["locks", "paid-job.lock"]);
    await writeFile(path, "");

    const ticks = await readProcessStartTicks(process.pid);
    if (ticks === undefined) throw new Error("Missing current process stat.");
    const active = metadata({
      pid: process.pid,
      procStartTicks: ticks,
      bootId: await readBootId(),
    });
    const writer = setTimeout(() => {
      void writeFile(path, `${JSON.stringify(active, null, 2)}\n`);
    }, 40);

    try {
      await expect(
        acquireLock(storage, ["locks", "paid-job.lock"], { kind: "paid-job" }),
      ).rejects.toThrow(LockHeldError);
    } finally {
      clearTimeout(writer);
    }
  });

  it("fails closed on malformed lock metadata without deleting it", async () => {
    const storage = await makeStorage();
    await storage.ensureDir(["locks"]);
    const path = storage.path(["locks", "paid-job.lock"]);
    await writeFile(path, "{not json");

    await expect(
      acquireLock(storage, ["locks", "paid-job.lock"], { kind: "paid-job" }),
    ).rejects.toThrow(LockUncertainError);
    expect(await readFile(path, "utf8")).toBe("{not json");
  });

  it("fails closed when process identity cannot be verified", async () => {
    const storage = await makeStorage();
    const procRoot = await makeProcRoot();
    const currentTicks = await readProcessStartTicks(process.pid);
    if (currentTicks === undefined) throw new Error("Missing current process stat.");
    await writeProcStat(procRoot, process.pid, statLine(process.pid, currentTicks));
    await writeProcStat(procRoot, 999, "malformed stat");
    await writeLock(storage, metadata({ pid: 999, procStartTicks: 100 }));
    const before = await readFile(storage.path(["locks", "paid-job.lock"]));

    await expect(
      acquireLock(storage, ["locks", "paid-job.lock"], {
        kind: "paid-job",
        procRoot,
      }),
    ).rejects.toThrow(LockUncertainError);
    expect(await readFile(storage.path(["locks", "paid-job.lock"]))).toEqual(before);
  });

  it("refuses to release a lock that was replaced by another owner", async () => {
    const storage = await makeStorage();
    const lock = await acquireLock(storage, ["locks", "paid-job.lock"], {
      kind: "paid-job",
      ownerId: "original-owner",
    });
    await writeLock(
      storage,
      metadata({ ownerId: "replacement-owner", pid: process.pid }),
    );

    await expect(lock.release()).rejects.toThrow(LockOwnershipError);
    const stored = await readLockMetadata(lock.path);
    expect(stored?.ownerId).toBe("replacement-owner");
    expect(await readFile(lock.path, "utf8")).toContain("replacement-owner");
  });

  it("detects a live owner in another process and reclaims after it dies", async () => {
    const base = await mkdtemp(join(tmpdir(), "ai-browser-lab-lock-child-"));
    tempDirs.push(base);
    const dataDir = join(base, "data");
    const moduleUrl = new URL("../src/server/server-lock.ts", import.meta.url).href;
    const code = `
      import { ensureServerLock } from ${JSON.stringify(moduleUrl)};
      const lock = await ensureServerLock();
      console.log("LOCKED " + lock.ownerId);
      setInterval(() => {}, 1000);
    `;

    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", code],
      {
        cwd: process.cwd(),
        env: { ...process.env, DATA_DIR: dataDir },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    try {
      await waitForOutput(child, /LOCKED/, 15_000);
      await expect(
        acquireLock(new Storage(dataDir), [".server.lock"], {
          kind: "server",
          ownerId: "parent-owner",
        }),
      ).rejects.toThrow(LockHeldError);

      child.kill("SIGKILL");
      await once(child, "exit");

      const lock = await acquireLock(new Storage(dataDir), [".server.lock"], {
        kind: "server",
        ownerId: "parent-owner",
      });
      expect(lock.ownerId).toBe("parent-owner");
      await lock.release();
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit").catch(() => undefined);
      }
    }
  }, 20_000);
});
