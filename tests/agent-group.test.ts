import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentGroupMemberPids,
  listAgentGroupMembers,
  listOwnedProcesses,
  readAgentProcessTable,
  terminateAgentWorkerGroup,
} from "../src/server/agent-group";
import type { AgentRunWorker } from "../src/server/agent-runs";
import {
  ProcessIdentityError,
  readBootId,
  readProcessGroupId,
  readProcessStartTicks,
} from "../src/server/process-identity";

const children: ChildProcess[] = [];
const tempDirs: string[] = [];

const FAST_GRACES = { sigtermGraceMs: 100, sigkillGraceMs: 100 };

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.pid !== undefined && child.exitCode === null) {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function track(child: ChildProcess): ChildProcess {
  children.push(child);
  return child;
}

/** Spawns a detached process that becomes its own process-group leader. */
function spawnGroupLeader(script: string, argv0?: string): ChildProcess {
  const child = spawn(process.execPath, ["-e", script], {
    ...(argv0 === undefined ? {} : { argv0 }),
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return track(child);
}

async function waitForExit(pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await readProcessStartTicks(pid)) === undefined) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Process ${pid} did not exit.`);
}

async function identityOf(pid: number): Promise<AgentRunWorker> {
  const [ticks, groupId, bootId] = await Promise.all([
    readProcessStartTicks(pid),
    readProcessGroupId(pid),
    readBootId(),
  ]);
  if (ticks === undefined || groupId === undefined) {
    throw new Error(`Process ${pid} is not running.`);
  }
  return { pid, groupId, procStartTicks: ticks, bootId };
}

async function deadPid(): Promise<number> {
  const child = track(spawn(process.execPath, ["-e", ""], { stdio: "ignore" }));
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  if (child.pid === undefined) throw new Error("Missing pid.");
  await waitForExit(child.pid);
  return child.pid;
}

async function makeProfileDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ai-browser-lab-profile-"));
  tempDirs.push(dir);
  return dir;
}

describe("agent worker group termination", () => {
  it("lists live members of a detached group with their command line", async () => {
    const profileDir = await makeProfileDir();
    const leader = spawnGroupLeader(
      "setInterval(() => {}, 1000)",
      `--user-data-dir=${profileDir}`,
    );
    const pid = leader.pid ?? 0;
    expect(pid).toBeGreaterThan(0);
    const identity = await identityOf(pid);
    expect(identity.groupId).toBe(pid);

    const members = await listAgentGroupMembers(identity.groupId);
    expect(members.map((member) => member.pid)).toEqual([pid]);
    expect(members[0]?.argv).toContain(`--user-data-dir=${profileDir}`);

    const result = await terminateAgentWorkerGroup(identity, {
      profileDir,
      ...FAST_GRACES,
    });
    expect(result.status).toBe("terminated");
    await waitForExit(pid);
    expect(await agentGroupMemberPids(identity.groupId)).toEqual([]);
  });

  it("terminates a verified group with SIGTERM", async () => {
    const profileDir = await makeProfileDir();
    const leader = spawnGroupLeader("setInterval(() => {}, 1000)");
    const identity = await identityOf(leader.pid ?? 0);

    const signals: string[] = [];
    const result = await terminateAgentWorkerGroup(identity, {
      profileDir,
      ...FAST_GRACES,
      onSignal: (signal) => signals.push(signal),
    });
    expect(result.status).toBe("terminated");
    expect(result.status === "terminated" && result.signals).toEqual([
      "SIGTERM",
    ]);
    expect(signals).toEqual(["SIGTERM"]);
    await waitForExit(identity.pid);
  });

  it("escalates to SIGKILL for a group that ignores SIGTERM", async () => {
    const profileDir = await makeProfileDir();
    const leader = spawnGroupLeader(
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
    );
    const identity = await identityOf(leader.pid ?? 0);

    const result = await terminateAgentWorkerGroup(identity, {
      profileDir,
      ...FAST_GRACES,
    });
    expect(result.status).toBe("terminated");
    expect(result.status === "terminated" && result.signals).toEqual([
      "SIGTERM",
      "SIGKILL",
    ]);
    await waitForExit(identity.pid);
  });

  it("never signals a reused PID", async () => {
    const profileDir = await makeProfileDir();
    const leader = spawnGroupLeader("setInterval(() => {}, 1000)");
    const identity = await identityOf(leader.pid ?? 0);

    const result = await terminateAgentWorkerGroup(
      { ...identity, procStartTicks: identity.procStartTicks + 1 },
      { profileDir, ...FAST_GRACES },
    );
    expect(result).toEqual({
      status: "skipped",
      reason: "pid-reused",
      memberPids: [],
    });
    expect(await readProcessStartTicks(identity.pid)).toBe(
      identity.procStartTicks,
    );
  });

  it("never signals a group after a boot change", async () => {
    const profileDir = await makeProfileDir();
    const leader = spawnGroupLeader("setInterval(() => {}, 1000)");
    const identity = await identityOf(leader.pid ?? 0);

    const result = await terminateAgentWorkerGroup(
      { ...identity, bootId: "00000000-0000-0000-0000-000000000000" },
      { profileDir, ...FAST_GRACES },
    );
    expect(result).toEqual({ status: "already-gone" });
    expect(await readProcessStartTicks(identity.pid)).toBe(
      identity.procStartTicks,
    );
  });

  it("signals only owned members when the leader is already gone", async () => {
    const profileDir = await makeProfileDir();
    // The leader spawns an owned grandchild in its group and exits.
    const leader = spawnGroupLeader(
      `const { spawn } = require("node:child_process");` +
        `spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { argv0: "--user-data-dir=" + ${JSON.stringify(profileDir)}, stdio: "ignore" }).unref();`,
    );
    const leaderPid = leader.pid ?? 0;
    const groupId = (await identityOf(leaderPid)).groupId;
    await waitForExit(leaderPid);

    let members = await agentGroupMemberPids(groupId);
    expect(members.length).toBeGreaterThan(0);
    const identity: AgentRunWorker = {
      pid: leaderPid,
      groupId,
      procStartTicks: 1,
      bootId: await readBootId(),
    };

    const result = await terminateAgentWorkerGroup(identity, {
      profileDir,
      ...FAST_GRACES,
    });
    expect(result.status).toBe("terminated");
    await new Promise((resolve) => setTimeout(resolve, 100));
    members = await agentGroupMemberPids(groupId);
    expect(members).toEqual([]);
  });

  it("leaves an unowned group untouched when the leader is gone", async () => {
    const profileDir = await makeProfileDir();
    const stranger = spawnGroupLeader("setInterval(() => {}, 1000)");
    const strangerPid = stranger.pid ?? 0;
    const groupId = (await identityOf(strangerPid)).groupId;

    const identity: AgentRunWorker = {
      pid: await deadPid(),
      groupId,
      procStartTicks: 1,
      bootId: await readBootId(),
    };
    const result = await terminateAgentWorkerGroup(identity, {
      profileDir,
      ...FAST_GRACES,
    });
    expect(result.status).toBe("skipped");
    expect(result.status === "skipped" && result.reason).toBe("not-owned");
    expect(result.status === "skipped" && result.memberPids).toContain(
      strangerPid,
    );
    expect(await readProcessStartTicks(strangerPid)).toBeDefined();
  });

  it("downgrades to owned members when the recorded group id is not the leader's", async () => {
    const profileDir = await makeProfileDir();
    const leader = spawnGroupLeader("setInterval(() => {}, 1000)");
    const identity = await identityOf(leader.pid ?? 0);
    const stranger = spawnGroupLeader("setInterval(() => {}, 1000)");
    const strangerPid = stranger.pid ?? 0;

    // The recorded group id points at a different group; a group signal would
    // be unsafe, so only members of that group with the profile marker may be
    // touched (none here).
    const result = await terminateAgentWorkerGroup(
      { ...identity, groupId: strangerPid },
      { profileDir, ...FAST_GRACES },
    );
    expect(result.status).toBe("skipped");
    expect(result.status === "skipped" && result.reason).toBe("not-owned");
    expect(await readProcessStartTicks(identity.pid)).toBe(
      identity.procStartTicks,
    );
    expect(await readProcessStartTicks(strangerPid)).toBeDefined();
  });

  it("does not claim a group is gone when the leader lives under another group", async () => {
    const profileDir = await makeProfileDir();
    const leader = spawnGroupLeader("setInterval(() => {}, 1000)");
    const identity = await identityOf(leader.pid ?? 0);
    const emptyGroupId = await deadPid();

    // The recorded group id is empty, but the recorded leader is alive with
    // matching ticks under a different group: report, never signal.
    const result = await terminateAgentWorkerGroup(
      { ...identity, groupId: emptyGroupId },
      { profileDir, ...FAST_GRACES },
    );
    expect(result).toEqual({
      status: "skipped",
      reason: "not-owned",
      memberPids: [],
    });
    expect(await readProcessStartTicks(identity.pid)).toBe(
      identity.procStartTicks,
    );
  });

  it("terminates owned processes that left the group via setsid", async () => {
    const profileDir = await makeProfileDir();
    const leader = spawnGroupLeader("setInterval(() => {}, 1000)");
    const identity = await identityOf(leader.pid ?? 0);
    // `setsid` gives the child a new session and process group, exactly like a
    // renderer or helper that detaches itself.
    const stray = spawn(
      "setsid",
      [
        process.execPath,
        "-e",
        "setInterval(() => {}, 1000)",
        "--",
        `--user-data-dir=${profileDir}`,
      ],
      { stdio: "ignore" },
    );
    stray.unref();
    track(stray);
    const strayPid = stray.pid ?? 0;
    expect(strayPid).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const strayIdentity = await identityOf(strayPid);
    expect(strayIdentity.groupId).toBe(strayPid);
    expect(strayIdentity.groupId).not.toBe(identity.groupId);

    const owned = await listOwnedProcesses(profileDir);
    expect(owned.map((process) => process.pid)).toEqual([strayPid]);

    const result = await terminateAgentWorkerGroup(identity, {
      profileDir,
      ...FAST_GRACES,
    });
    expect(result.status).toBe("terminated");
    await waitForExit(identity.pid);
    await waitForExit(strayPid);
    expect(await listOwnedProcesses(profileDir)).toEqual([]);
  });

  it("owns an unmarked descendant of a setsid stray through the marker ancestor", async () => {
    const profileDir = await makeProfileDir();
    const scriptDir = await mkdtemp(join(tmpdir(), "ai-browser-lab-stray-"));
    tempDirs.push(scriptDir);
    const scriptPath = join(scriptDir, "stray.js");
    const pidFile = join(scriptDir, "child.pid");
    await writeFile(
      scriptPath,
      [
        'const { spawn } = require("node:child_process");',
        'const { writeFileSync } = require("node:fs");',
        'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
        "child.unref();",
        "writeFileSync(process.argv[2], String(child.pid));",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    const leader = spawnGroupLeader("setInterval(() => {}, 1000)");
    const identity = await identityOf(leader.pid ?? 0);
    const stray = spawn(
      "setsid",
      [process.execPath, scriptPath, pidFile, "--", `--user-data-dir=${profileDir}`],
      { stdio: "ignore" },
    );
    stray.unref();
    track(stray);
    const strayPid = stray.pid ?? 0;
    expect(strayPid).toBeGreaterThan(0);

    const deadline = Date.now() + 5_000;
    let childPid = 0;
    while (Date.now() < deadline && childPid === 0) {
      try {
        childPid = Number((await readFile(pidFile, "utf8")).trim());
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    expect(childPid).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await identityOf(strayPid)).groupId).not.toBe(identity.groupId);
    const child = await identityOf(childPid);
    expect(child.groupId).toBe(strayPid);
    // The child carries no marker; ownership comes from its marked ancestor.
    const members = await listAgentGroupMembers(child.groupId);
    expect(members.map((member) => member.pid)).toContain(childPid);
    expect(
      members
        .find((member) => member.pid === childPid)
        ?.argv?.includes(`--user-data-dir=${profileDir}`) ?? false,
    ).toBe(false);

    const result = await terminateAgentWorkerGroup(identity, {
      profileDir,
      ...FAST_GRACES,
    });
    expect(result.status).toBe("terminated");
    await waitForExit(strayPid);
    await waitForExit(childPid);
    expect(await listOwnedProcesses(profileDir)).toEqual([]);
  });

  it("owns group members that descend from a profile-marked process", async () => {
    const profileDir = await makeProfileDir();
    const innerScript =
      'const { spawn } = require("node:child_process");' +
      'spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }).unref();' +
      "setInterval(() => {}, 1000);";
    const leader = spawnGroupLeader(
      'const { spawn } = require("node:child_process");' +
        `spawn(process.execPath, ["-e", ${JSON.stringify(innerScript)}], { argv0: "--user-data-dir=" + ${JSON.stringify(profileDir)}, stdio: "ignore" }).unref();`,
    );
    const leaderPid = leader.pid ?? 0;
    const groupId = (await identityOf(leaderPid)).groupId;
    await waitForExit(leaderPid);

    // A marked child and an unmarked grandchild remain in the group; wait for
    // the nested spawn to land.
    const deadline = Date.now() + 5_000;
    let members = await listAgentGroupMembers(groupId);
    let marked = members.filter(
      (member) => member.argv?.includes(`--user-data-dir=${profileDir}`) ?? false,
    );
    let unmarked = members.filter(
      (member) => !(member.argv?.includes(`--user-data-dir=${profileDir}`) ?? false),
    );
    while (
      Date.now() < deadline &&
      (marked.length === 0 || unmarked.length === 0)
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      members = await listAgentGroupMembers(groupId);
      marked = members.filter(
        (member) =>
          member.argv?.includes(`--user-data-dir=${profileDir}`) ?? false,
      );
      unmarked = members.filter(
        (member) =>
          !(member.argv?.includes(`--user-data-dir=${profileDir}`) ?? false),
      );
    }
    expect(marked.length).toBeGreaterThanOrEqual(1);
    expect(unmarked.length).toBeGreaterThanOrEqual(1);

    const identity: AgentRunWorker = {
      pid: leaderPid,
      groupId,
      procStartTicks: 1,
      bootId: await readBootId(),
    };
    const result = await terminateAgentWorkerGroup(identity, {
      profileDir,
      ...FAST_GRACES,
    });
    expect(result.status).toBe("terminated");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await listAgentGroupMembers(groupId)).toEqual([]);
  });

  it("reports a missing identity and an already-empty group", async () => {
    const profileDir = await makeProfileDir();
    expect(
      await terminateAgentWorkerGroup(null, { profileDir, ...FAST_GRACES }),
    ).toEqual({ status: "skipped", reason: "no-identity", memberPids: [] });

    const gonePid = await deadPid();
    const identity: AgentRunWorker = {
      pid: gonePid,
      groupId: gonePid,
      procStartTicks: 1,
      bootId: await readBootId(),
    };
    expect(
      await terminateAgentWorkerGroup(identity, { profileDir, ...FAST_GRACES }),
    ).toEqual({ status: "already-gone" });
  });
});

describe("agent process table fail-closed behavior", () => {
  it("propagates an unreadable stat instead of treating the group as gone", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-proc-unreadable-"));
    tempDirs.push(root);
    await mkdir(join(root, "123"), { recursive: true });
    await writeFile(join(root, "123", "stat"), "not a proc stat\n");
    await expect(readAgentProcessTable({ procRoot: root })).rejects.toBeInstanceOf(
      ProcessIdentityError,
    );
  });

  it("ignores namespace init processes whose process group is 0", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-proc-init-"));
    tempDirs.push(root);
    await mkdir(join(root, "11"), { recursive: true });
    await writeFile(
      join(root, "11", "stat"),
      "11 (init) S 2 0 0 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 4 0 475 5038080 885\n",
    );
    await expect(readAgentProcessTable({ procRoot: root })).resolves.toEqual(
      [],
    );
  });
});
