import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getCurrentProcessIdentity,
  parseProcGroupId,
  parseProcStat,
  ProcessIdentityError,
  readBootId,
  readProcessGroupId,
  readProcessIdentity,
  readProcessStartTicks,
} from "../src/server/process-identity";

const tempDirs: string[] = [];

async function makeProcRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ai-browser-lab-proc-"));
  tempDirs.push(root);
  await mkdir(join(root, "sys", "kernel", "random"), { recursive: true });
  await writeFile(join(root, "sys", "kernel", "random", "boot_id"), "test-boot-id\n");
  return root;
}

function statLine(
  pid: number,
  ticks: number,
  comm = "node",
  groupId = pid,
): string {
  const fields = Array.from({ length: 49 }, (_, index) => {
    if (index === 1) return String(groupId);
    if (index === 18) return String(ticks);
    return "0";
  });
  return `${pid} (${comm}) S ${fields.join(" ")}\n`;
}

async function writeProcStat(root: string, pid: number, content: string): Promise<void> {
  await mkdir(join(root, String(pid)), { recursive: true });
  await writeFile(join(root, String(pid), "stat"), content);
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("Linux process identity", () => {
  it("reads the boot ID and process start ticks from /proc", async () => {
    const root = await makeProcRoot();
    await writeProcStat(root, 123, statLine(123, 4242, "node (worker)"));

    expect(await readBootId({ procRoot: root })).toBe("test-boot-id");
    expect(await readProcessStartTicks(123, { procRoot: root })).toBe(4242);
    expect(await readProcessGroupId(123, { procRoot: root })).toBe(123);
    expect(await readProcessIdentity(123, { procRoot: root })).toEqual({
      pid: 123,
      procStartTicks: 4242,
      bootId: "test-boot-id",
    });
  });

  it("reads a detached worker's own process group", async () => {
    const root = await makeProcRoot();
    await writeProcStat(root, 321, statLine(321, 77, "node", 321));
    expect(await readProcessGroupId(321, { procRoot: root })).toBe(321);
    expect(parseProcGroupId(321, statLine(321, 77, "node", 321))).toBe(321);
    expect(() => parseProcGroupId(321, "321 (node) S 1 0 3")).toThrow(
      ProcessIdentityError,
    );
    expect(await readProcessGroupId(999, { procRoot: root })).toBeUndefined();
  });

  it("distinguishes a missing process from malformed metadata", async () => {
    const root = await makeProcRoot();
    expect(await readProcessStartTicks(999, { procRoot: root })).toBeUndefined();
    await expect(readProcessIdentity(999, { procRoot: root })).rejects.toThrow(
      /not present/,
    );

    await writeProcStat(root, 124, "not-a-stat-line");
    await expect(readProcessStartTicks(124, { procRoot: root })).rejects.toThrow(
      ProcessIdentityError,
    );
  });

  it("parses the command field even when it contains spaces and parentheses", () => {
    expect(parseProcStat(7, statLine(7, 91, "node (dev) worker"))).toBe(91);
    expect(() => parseProcStat(7, "7 (node) S 1 2 3")).toThrow(ProcessIdentityError);
  });

  it("rejects invalid PIDs and missing boot IDs", async () => {
    const root = await makeProcRoot();
    for (const pid of [0, -1, 1.5, 2 ** 31]) {
      expect(() => parseProcStat(pid, statLine(pid, 1))).toThrow(ProcessIdentityError);
      await expect(readProcessStartTicks(pid, { procRoot: root })).rejects.toThrow(
        ProcessIdentityError,
      );
    }

    await rm(join(root, "sys", "kernel", "random", "boot_id"));
    await expect(readBootId({ procRoot: root })).rejects.toThrow(
      /boot ID/,
    );
  });

  it("reads the real identity of this test process", async () => {
    const identity = await getCurrentProcessIdentity();
    expect(identity.pid).toBe(process.pid);
    expect(identity.procStartTicks).toBeGreaterThanOrEqual(0);
    expect(identity.bootId.length).toBeGreaterThan(0);
  });
});
