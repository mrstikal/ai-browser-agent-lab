import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface ProcessIdentity {
  readonly pid: number;
  readonly procStartTicks: number;
  readonly bootId: string;
}

export interface ProcOptions {
  readonly procRoot?: string | undefined;
}

export class ProcessIdentityError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProcessIdentityError";
  }
}

const DEFAULT_PROC_ROOT = "/proc";
const MAX_BOOT_ID_LENGTH = 128;

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function procRoot(options: ProcOptions): string {
  return options.procRoot ?? DEFAULT_PROC_ROOT;
}

function assertPid(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0 || pid > 2 ** 31 - 1) {
    throw new ProcessIdentityError(`Invalid process ID: ${String(pid)}.`);
  }
}

export async function readBootId(options: ProcOptions = {}): Promise<string> {
  const target = join(procRoot(options), "sys", "kernel", "random", "boot_id");
  let raw: string;
  try {
    raw = await readFile(target, "utf8");
  } catch (error) {
    throw new ProcessIdentityError(
      `Cannot read the Linux boot ID from ${target}. Phase 7 requires Linux or WSL.`,
      { cause: error },
    );
  }

  const bootId = raw.trim();
  if (
    bootId.length === 0 ||
    bootId.length > MAX_BOOT_ID_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(bootId)
  ) {
    throw new ProcessIdentityError(`The Linux boot ID at ${target} is malformed.`);
  }
  return bootId;
}

export function parseProcStat(pid: number, content: string): number {
  assertPid(pid);
  const close = content.lastIndexOf(")");
  if (close < 0) {
    throw new ProcessIdentityError(`Malformed /proc/${pid}/stat: missing command field.`);
  }

  const fields = content.slice(close + 1).trim().split(/\s+/);
  const state = fields[0];
  if (state === undefined || state.length !== 1) {
    throw new ProcessIdentityError(`Malformed /proc/${pid}/stat: missing process state.`);
  }

  const rawTicks = fields[19];
  if (rawTicks === undefined || !/^\d+$/.test(rawTicks)) {
    throw new ProcessIdentityError(
      `Malformed /proc/${pid}/stat: missing or invalid process start ticks.`,
    );
  }

  const ticks = Number(rawTicks);
  if (!Number.isSafeInteger(ticks) || ticks < 0) {
    throw new ProcessIdentityError(
      `Malformed /proc/${pid}/stat: process start ticks are out of range.`,
    );
  }
  return ticks;
}

export async function readProcessStartTicks(
  pid: number,
  options: ProcOptions = {},
): Promise<number | undefined> {
  assertPid(pid);
  const target = join(procRoot(options), String(pid), "stat");
  try {
    return parseProcStat(pid, await readFile(target, "utf8"));
  } catch (error) {
    if (isNotFound(error)) return undefined;
    if (error instanceof ProcessIdentityError) throw error;
    throw new ProcessIdentityError(`Cannot read process identity from ${target}.`, {
      cause: error,
    });
  }
}

export async function readProcessIdentity(
  pid: number,
  options: ProcOptions = {},
): Promise<ProcessIdentity> {
  const [procStartTicks, bootId] = await Promise.all([
    readProcessStartTicks(pid, options),
    readBootId(options),
  ]);
  if (procStartTicks === undefined) {
    throw new ProcessIdentityError(`Process ${pid} is not present in /proc.`);
  }
  return { pid, procStartTicks, bootId };
}

export async function getCurrentProcessIdentity(
  options: ProcOptions = {},
): Promise<ProcessIdentity> {
  return readProcessIdentity(process.pid, options);
}
