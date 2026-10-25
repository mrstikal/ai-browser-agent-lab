import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { AgentRunWorker } from "./agent-runs";
import {
  parseProcStat,
  ProcessIdentityError,
  readBootId,
  type ProcOptions,
} from "./process-identity";

/**
 * Verified termination of one agent worker's process group.
 *
 * The worker is spawned detached, so its PID is its process-group ID and every
 * Chromium helper of that run belongs to the group. Because a PID or group ID
 * can be reused, nothing is ever signaled until the target identity (recorded
 * or freshly scanned start ticks) is verified; when the leader is gone only
 * processes that are provably ours are signaled per PID.
 *
 * Ownership is the exact `--user-data-dir=<profileDir>` argv element plus every
 * descendant of such a process. A free probe against the real SDK Chromium
 * (Chrome 147, Linux/WSL) shows the browser main process, zygotes,
 * GPU/utility/renderer helpers and the crashpad launcher all carry that flag;
 * only Chromium's shared crashpad handler runs in its own session without it,
 * which is why it is never attributed (it is shared and exits on its own).
 *
 * Descendants that call `setsid` leave the group, so every scan also looks for
 * owned processes in ANY group and terminates them per PID. Unattributable
 * processes are reported, never signaled.
 */

export const AGENT_SIGTERM_GRACE_MS = 2_000;
export const AGENT_SIGKILL_GRACE_MS = 1_000;

export type AgentGroupSignal = "SIGTERM" | "SIGKILL";

/** One live (non-zombie) `/proc` entry relevant to ownership decisions. */
export interface AgentProcessEntry {
  readonly pid: number;
  readonly ppid: number;
  readonly groupId: number;
  readonly procStartTicks: number;
  /** argv of `/proc/<pid>/cmdline`, or null when it cannot be read. */
  readonly argv: readonly string[] | null;
}

export type AgentGroupMember = AgentProcessEntry;

/** A live process anywhere in `/proc` that is owned by one agent run. */
export interface AgentOwnedProcess {
  readonly pid: number;
  readonly ppid: number;
  readonly groupId: number;
  readonly procStartTicks: number;
}

export type AgentGroupSkipReason =
  | "no-identity"
  | "unverifiable"
  | "boot-changed"
  | "pid-reused"
  | "not-owned";

export type AgentGroupTermination =
  | {
      readonly status: "terminated";
      readonly signals: readonly AgentGroupSignal[];
      readonly remainingPids: readonly number[];
    }
  | { readonly status: "already-gone" }
  | {
      readonly status: "skipped";
      readonly reason: AgentGroupSkipReason;
      readonly memberPids: readonly number[];
    }
  | {
      readonly status: "escaped";
      readonly signals: readonly AgentGroupSignal[];
      readonly remainingPids: readonly number[];
    };

export interface TerminateAgentGroupOptions extends ProcOptions {
  /** Absolute profile directory that marks processes as owned by this run. */
  readonly profileDir: string;
  readonly sigtermGraceMs?: number | undefined;
  readonly sigkillGraceMs?: number | undefined;
  readonly sleepImpl?: ((ms: number) => Promise<void>) | undefined;
  readonly onSignal?:
    | ((signal: AgentGroupSignal, pids: readonly number[]) => void)
    | undefined;
}

interface ProcStatFields {
  readonly procStartTicks: number;
  readonly groupId: number;
  readonly ppid: number;
  /** `Z` for zombies: the entry exists but the process can no longer run. */
  readonly state: string;
}

async function readProcStatFields(
  pid: number,
  options: ProcOptions,
): Promise<ProcStatFields | undefined> {
  const target = join(options.procRoot ?? "/proc", String(pid), "stat");
  let content: string;
  try {
    content = await readFile(target, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ESRCH") return undefined;
    throw new ProcessIdentityError(`Cannot read ${target}.`, { cause: error });
  }
  const close = content.lastIndexOf(")");
  const state = close < 0 ? undefined : content.slice(close + 1).trim()[0];
  if (state === undefined) {
    throw new ProcessIdentityError(`Malformed ${target}: missing process state.`);
  }
  const fields = content.slice(close + 1).trim().split(/\s+/);
  const rawPpid = fields[1];
  const ppid = rawPpid !== undefined && /^\d+$/.test(rawPpid) ? Number(rawPpid) : 0;
  // Group ID 0 is used by kernel/namespace init processes. It can never be
  // an agent worker group (the worker is spawned detached with pgid = pid),
  // so it is parsed here instead of being treated as a malformed stat.
  const rawGroup = fields[2];
  if (rawGroup === undefined || !/^\d+$/.test(rawGroup)) {
    throw new ProcessIdentityError(
      `Malformed ${target}: missing or invalid process group ID.`,
    );
  }
  const groupId = Number(rawGroup);
  if (!Number.isSafeInteger(groupId) || groupId < 0 || groupId > 2 ** 31 - 1) {
    throw new ProcessIdentityError(
      `Malformed ${target}: process group ID is out of range.`,
    );
  }
  return {
    procStartTicks: parseProcStat(pid, content),
    groupId,
    ppid,
    state,
  };
}

async function readProcArgv(
  pid: number,
  options: ProcOptions,
): Promise<readonly string[] | null> {
  const target = join(options.procRoot ?? "/proc", String(pid), "cmdline");
  let raw: string;
  try {
    raw = await readFile(target, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // A process can exit between the stat and cmdline reads. Any other error
    // means ownership cannot be decided, so fail closed instead of silently
    // treating a live process as unowned.
    if (code === "ENOENT" || code === "ESRCH") return null;
    throw new ProcessIdentityError(`Cannot read ${target}.`, { cause: error });
  }
  const argv = raw.split("\u0000").filter((part) => part.length > 0);
  return argv.length > 0 ? argv : null;
}

/** The exact argv element the real SDK Chromium passes to every helper. */
function profileArg(profileDir: string): string {
  return `--user-data-dir=${profileDir}`;
}

function isMarked(entry: AgentProcessEntry, profileDir: string): boolean {
  return entry.argv !== null && entry.argv.includes(profileArg(profileDir));
}

/**
 * Reads every live process once. Ownership is computed from this table so the
 * marker rule and its descendant closure are applied consistently to group
 * members and out-of-group strays.
 */
export async function readAgentProcessTable(
  options: ProcOptions = {},
): Promise<AgentProcessEntry[]> {
  const procRoot = options.procRoot ?? "/proc";
  let names: string[];
  try {
    names = await readdir(procRoot);
  } catch (error) {
    throw new ProcessIdentityError(`Cannot list ${procRoot}.`, { cause: error });
  }

  const table: AgentProcessEntry[] = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    // A process that exits between readdir and the stat read returns
    // undefined. Any other error is not proof of disappearance: propagate it
    // so the caller reports an unverifiable group instead of a false "gone".
    const fields = await readProcStatFields(pid, options);
    if (!fields || fields.state === "Z" || fields.groupId === 0) continue;
    table.push({
      pid,
      ppid: fields.ppid,
      groupId: fields.groupId,
      procStartTicks: fields.procStartTicks,
      argv: await readProcArgv(pid, options),
    });
  }
  return table.sort((left, right) => left.pid - right.pid);
}

/**
 * Marker-matched processes plus their transitive descendants. A descendant is
 * owned only while its parent is owned, so an unrelated process can never be
 * attributed (its ancestor chain does not include a marked process).
 */
export function ownedProcessIds(
  table: readonly AgentProcessEntry[],
  profileDir: string,
): Set<number> {
  const owned = new Set(
    table
      .filter((entry) => isMarked(entry, profileDir))
      .map((entry) => entry.pid),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of table) {
      if (owned.has(entry.pid)) continue;
      if (owned.has(entry.ppid)) {
        owned.add(entry.pid);
        changed = true;
      }
    }
  }
  return owned;
}

/**
 * Lists the live members of one process group. Reading every `/proc/<pid>/stat`
 * is cheap enough for a local lab and avoids depending on `ps` being installed.
 */
export async function listAgentGroupMembers(
  groupId: number,
  options: ProcOptions = {},
): Promise<AgentGroupMember[]> {
  const table = await readAgentProcessTable(options);
  return table.filter((entry) => entry.groupId === groupId);
}

/**
 * Live processes in ANY process group that are owned by the run (profile
 * marker or descendant of a marked process). Catches descendants that called
 * `setsid` and therefore left the worker's group.
 */
export async function listOwnedProcesses(
  profileDir: string,
  options: ProcOptions = {},
): Promise<AgentOwnedProcess[]> {
  if (profileDir.length === 0) return [];
  const table = await readAgentProcessTable(options);
  const owned = ownedProcessIds(table, profileDir);
  return table
    .filter((entry) => owned.has(entry.pid))
    .map((entry) => ({
      pid: entry.pid,
      ppid: entry.ppid,
      groupId: entry.groupId,
      procStartTicks: entry.procStartTicks,
    }));
}

export interface TerminateOwnedProcessesOptions extends ProcOptions {
  readonly sigtermGraceMs?: number | undefined;
  readonly sigkillGraceMs?: number | undefined;
  readonly sleepImpl?: ((ms: number) => Promise<void>) | undefined;
  readonly excludePids?: readonly number[] | undefined;
  readonly onSignal?: ((signal: AgentGroupSignal, pids: readonly number[]) => void) | undefined;
}

export type OwnedProcessTermination =
  | {
      readonly status: "terminated";
      readonly signals: readonly AgentGroupSignal[];
      readonly remainingPids: readonly number[];
    }
  | { readonly status: "already-gone" }
  | {
      readonly status: "escaped";
      readonly signals: readonly AgentGroupSignal[];
      readonly remainingPids: readonly number[];
    };

/**
 * Worker-side orphan cleanup. Unlike group termination this never signals the
 * caller or its ancestors: only profile-marked Chromium processes and their
 * descendants are targeted, and every PID is re-verified by start ticks.
 */
export async function terminateOwnedAgentProcesses(
  profileDir: string,
  options: TerminateOwnedProcessesOptions = {},
): Promise<OwnedProcessTermination> {
  const sleep =
    options.sleepImpl ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const sigtermGraceMs = options.sigtermGraceMs ?? AGENT_SIGTERM_GRACE_MS;
  const sigkillGraceMs = options.sigkillGraceMs ?? AGENT_SIGKILL_GRACE_MS;
  const procOptions: ProcOptions = { procRoot: options.procRoot };
  const excluded = new Set<number>([process.pid, ...(options.excludePids ?? [])]);
  const signals: AgentGroupSignal[] = [];

  const scan = async (): Promise<AgentOwnedProcess[]> => {
    const owned = await listOwnedProcesses(profileDir, procOptions);
    return owned.filter((entry) => !excluded.has(entry.pid));
  };

  const signalVerified = async (
    signal: AgentGroupSignal,
  ): Promise<number> => {
    const targets = await scan();
    const verified: AgentOwnedProcess[] = [];
    for (const target of targets) {
      let current: ProcStatFields | undefined;
      try {
        current = await readProcStatFields(target.pid, procOptions);
      } catch {
        continue;
      }
      if (
        current === undefined ||
        current.state === "Z" ||
        current.procStartTicks !== target.procStartTicks
      ) {
        continue;
      }
      verified.push(target);
    }
    if (verified.length === 0) return 0;
    options.onSignal?.(
      signal,
      verified.map((entry) => entry.pid),
    );
    signalPids(
      verified.map((entry) => entry.pid),
      signal,
    );
    return verified.length;
  };

  if (profileDir.length === 0) return { status: "already-gone" };
  if ((await scan()).length === 0) return { status: "already-gone" };

  if ((await signalVerified("SIGTERM")) > 0) signals.push("SIGTERM");
  await sleep(sigtermGraceMs);
  if ((await scan()).length === 0) {
    return { status: "terminated", signals, remainingPids: [] };
  }

  if ((await signalVerified("SIGKILL")) > 0) signals.push("SIGKILL");
  await sleep(sigkillGraceMs);
  const remaining = await scan();
  if (remaining.length === 0) {
    return { status: "terminated", signals, remainingPids: [] };
  }
  return {
    status: "escaped",
    signals,
    remainingPids: remaining.map((entry) => entry.pid),
  };
}

function signalPids(pids: readonly number[], signal: AgentGroupSignal): void {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch {
      // ESRCH (already gone) and EPERM are both safe to ignore here; the
      // final member scan decides the outcome.
    }
  }
}

function signalGroup(
  groupId: number,
  members: readonly AgentGroupMember[],
  signal: AgentGroupSignal,
): void {
  try {
    process.kill(-groupId, signal);
    return;
  } catch {
    // The group may be gone or not signalable as a whole; fall back to the
    // members this scan observed.
    signalPids(
      members.map((member) => member.pid),
      signal,
    );
  }
}

export async function terminateAgentWorkerGroup(
  worker: AgentRunWorker | null,
  options: TerminateAgentGroupOptions,
): Promise<AgentGroupTermination> {
  const sleep =
    options.sleepImpl ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const sigtermGraceMs = options.sigtermGraceMs ?? AGENT_SIGTERM_GRACE_MS;
  const sigkillGraceMs = options.sigkillGraceMs ?? AGENT_SIGKILL_GRACE_MS;
  const procOptions: ProcOptions = { procRoot: options.procRoot };
  const notify = (signal: AgentGroupSignal, pids: readonly number[]): void => {
    options.onSignal?.(signal, pids);
  };

  if (!worker) {
    return { status: "skipped", reason: "no-identity", memberPids: [] };
  }

  let bootId: string;
  try {
    bootId = await readBootId(procOptions);
  } catch {
    return { status: "skipped", reason: "unverifiable", memberPids: [] };
  }
  if (worker.bootId !== bootId) {
    // Processes from a previous boot cannot survive a reboot. There is no
    // current-boot PID that could still belong to this run, so the ownership
    // is provably gone without signaling any process.
    return { status: "already-gone" };
  }

  const leader = await readProcStatFields(worker.pid, procOptions);
  const leaderAlive = leader !== undefined && leader.state !== "Z";
  if (leaderAlive && leader.procStartTicks !== worker.procStartTicks) {
    // The PID belongs to a different process now: never signal it.
    return { status: "skipped", reason: "pid-reused", memberPids: [] };
  }

  interface Scan {
    readonly members: readonly AgentProcessEntry[];
    /** Owned (marker or descendant) processes outside the worker's group. */
    readonly strays: readonly AgentProcessEntry[];
    readonly ownedIds: ReadonlySet<number>;
  }

  const scan = async (): Promise<Scan> => {
    const table = await readAgentProcessTable(procOptions);
    const ownedIds = ownedProcessIds(table, options.profileDir);
    const members = table.filter((entry) => entry.groupId === worker.groupId);
    return {
      members,
      ownedIds,
      strays: table.filter(
        (entry) => ownedIds.has(entry.pid) && entry.groupId !== worker.groupId,
      ),
    };
  };
  const isGone = (state: Scan): boolean =>
    state.members.length === 0 && state.strays.length === 0;
  const remainingPids = (state: Scan): number[] => [
    ...state.members.map((member) => member.pid),
    ...state.strays.map((stray) => stray.pid),
  ];

  /**
   * Signals per-PID targets only after re-reading their start ticks, so a PID
   * that exited and was reused between scan and signal is skipped.
   */
  const signalVerifiedPids = async (
    targets: ReadonlyArray<{ readonly pid: number; readonly procStartTicks: number }>,
    signal: AgentGroupSignal,
  ): Promise<number> => {
    const verified: number[] = [];
    for (const target of targets) {
      let current: ProcStatFields | undefined;
      try {
        current = await readProcStatFields(target.pid, procOptions);
      } catch {
        continue;
      }
      if (
        current === undefined ||
        current.state === "Z" ||
        current.procStartTicks !== target.procStartTicks
      ) {
        continue;
      }
      verified.push(target.pid);
    }
    if (verified.length === 0) return 0;
    notify(signal, verified);
    signalPids(verified, signal);
    return verified.length;
  };

  const signalStrays = async (
    signal: AgentGroupSignal,
    strays: readonly AgentProcessEntry[],
  ): Promise<number> => signalVerifiedPids(strays, signal);

  /**
   * Re-verifies the leader immediately before each signal. A group signal is
   * only sent while the recorded identity is still exact (leader alive, same
   * start ticks, same group, group == pid); otherwise only per-PID members
   * that are provably owned are signaled.
   */
  const signalGroupPhase = async (
    signal: AgentGroupSignal,
    state: Scan,
  ): Promise<{ kind: "group" | "owned" | "none" | "unowned"; signaled: number }> => {
    if (state.members.length === 0) return { kind: "none", signaled: 0 };

    const current = await readProcStatFields(worker.pid, procOptions);
    const verified =
      worker.groupId === worker.pid &&
      current !== undefined &&
      current.state !== "Z" &&
      current.procStartTicks === worker.procStartTicks &&
      current.groupId === worker.groupId;
    if (verified) {
      notify(
        signal,
        state.members.map((member) => member.pid),
      );
      signalGroup(worker.groupId, state.members, signal);
      return { kind: "group", signaled: state.members.length };
    }

    const ownedMembers = state.members.filter((member) =>
      state.ownedIds.has(member.pid),
    );
    if (ownedMembers.length === 0) return { kind: "unowned", signaled: 0 };
    const signaled = await signalVerifiedPids(ownedMembers, signal);
    return signaled > 0
      ? { kind: "owned", signaled }
      : { kind: "none", signaled: 0 };
  };

  let state = await scan();
  if (isGone(state)) {
    const groupInconsistent =
      leaderAlive &&
      (worker.groupId !== worker.pid || leader.groupId !== worker.groupId);
    if (!groupInconsistent) return { status: "already-gone" };
    // The leader is alive but the recorded group does not match it: report
    // instead of claiming the group is gone, and signal nothing.
    return { status: "skipped", reason: "not-owned", memberPids: [] };
  }

  const signals: AgentGroupSignal[] = [];

  const firstGroup = await signalGroupPhase("SIGTERM", state);
  const firstStrays = await signalStrays("SIGTERM", state.strays);
  if (firstGroup.signaled > 0 || firstStrays > 0) signals.push("SIGTERM");

  if (signals.length === 0) {
    // Nothing in this group is provably ours; report instead of signaling.
    return {
      status: "skipped",
      reason: "not-owned",
      memberPids: state.members.map((member) => member.pid),
    };
  }

  await sleep(sigtermGraceMs);
  state = await scan();
  if (isGone(state)) return { status: "terminated", signals, remainingPids: [] };

  const secondGroup = await signalGroupPhase("SIGKILL", state);
  const secondStrays = await signalStrays("SIGKILL", state.strays);
  if (secondGroup.signaled > 0 || secondStrays > 0) signals.push("SIGKILL");
  await sleep(sigkillGraceMs);

  state = await scan();
  if (isGone(state)) return { status: "terminated", signals, remainingPids: [] };
  if (secondGroup.kind === "unowned" && state.strays.length === 0) {
    // The remaining group members were never provably ours; keep the honest
    // "skipped" report even though other owned processes were cleaned up.
    return {
      status: "skipped",
      reason: "not-owned",
      memberPids: state.members.map((member) => member.pid),
    };
  }
  return {
    status: "escaped",
    signals,
    remainingPids: remainingPids(state),
  };
}

export async function agentGroupMemberPids(
  groupId: number,
  options: ProcOptions = {},
): Promise<number[]> {
  return (await listAgentGroupMembers(groupId, options)).map(
    (member) => member.pid,
  );
}
