import { randomUUID } from "node:crypto";
import { constants, existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { link, lstat, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  getCurrentProcessIdentity,
  readProcessStartTicks,
  type ProcessIdentity,
  type ProcOptions,
} from "./process-identity";
import { PRIVATE_FILE_MODE, Storage } from "./storage";

export const LOCK_VERSION = 1;

export interface LockMetadata extends ProcessIdentity {
  readonly version: typeof LOCK_VERSION;
  readonly kind: string;
  readonly ownerId: string;
  readonly acquiredAt: string;
}

export type LockOwnerStatus =
  | { readonly state: "active" }
  | {
      readonly state: "stale";
      readonly reason: "boot-id-changed" | "process-missing" | "process-reused";
    }
  | { readonly state: "uncertain"; readonly reason: string };

export interface AcquireLockOptions extends ProcOptions {
  readonly kind: string;
  readonly ownerId?: string;
  readonly now?: () => Date;
  readonly maxAttempts?: number;
  readonly releaseOnExit?: boolean;
}

export class LockError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LockError";
  }
}

export class LockConfigError extends LockError {
  constructor(message: string) {
    super(message);
    this.name = "LockConfigError";
  }
}

export class LockHeldError extends LockError {
  readonly owner: LockMetadata;

  constructor(message: string, owner: LockMetadata) {
    super(message);
    this.name = "LockHeldError";
    this.owner = owner;
  }
}

export class LockUncertainError extends LockError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LockUncertainError";
  }
}

export class LockOwnershipError extends LockError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LockOwnershipError";
  }
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isIgnorableSyncError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EINVAL" || code === "ENOTSUP" || code === "ENOSYS";
}

function isNonEmptyString(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

export function parseLockMetadata(value: unknown): LockMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LockUncertainError("Lock metadata must be a JSON object.");
  }
  const record = value as Record<string, unknown>;
  const { version, kind, ownerId, pid, procStartTicks, bootId, acquiredAt } = record;

  if (version !== LOCK_VERSION) {
    throw new LockUncertainError(
      `Unsupported lock metadata version: ${String(version)}.`,
    );
  }
  if (!isNonEmptyString(kind, 64)) {
    throw new LockUncertainError("Lock metadata has an invalid kind.");
  }
  if (!isNonEmptyString(ownerId, 128)) {
    throw new LockUncertainError("Lock metadata has an invalid ownerId.");
  }
  if (!Number.isInteger(pid) || (pid as number) <= 0 || (pid as number) > 2 ** 31 - 1) {
    throw new LockUncertainError("Lock metadata has an invalid pid.");
  }
  if (!Number.isSafeInteger(procStartTicks) || (procStartTicks as number) < 0) {
    throw new LockUncertainError("Lock metadata has invalid procStartTicks.");
  }
  if (!isNonEmptyString(bootId, 128)) {
    throw new LockUncertainError("Lock metadata has an invalid bootId.");
  }
  if (!isNonEmptyString(acquiredAt, 64) || Number.isNaN(Date.parse(acquiredAt))) {
    throw new LockUncertainError("Lock metadata has an invalid acquiredAt timestamp.");
  }

  return {
    version: LOCK_VERSION,
    kind,
    ownerId,
    pid: pid as number,
    procStartTicks: procStartTicks as number,
    bootId,
    acquiredAt,
  };
}

export function sameOwner(left: LockMetadata, right: LockMetadata): boolean {
  return (
    left.ownerId === right.ownerId &&
    left.pid === right.pid &&
    left.procStartTicks === right.procStartTicks &&
    left.bootId === right.bootId
  );
}

async function readLockFile(path: string): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw new LockUncertainError(
      `Cannot open the lock file at ${path}; ownership cannot be verified.`,
      { cause: error },
    );
  }

  try {
    return await handle.readFile({ encoding: "utf8" });
  } catch (error) {
    throw new LockUncertainError(
      `Cannot read the lock file at ${path}; ownership cannot be verified.`,
      { cause: error },
    );
  } finally {
    await handle.close().catch(() => undefined);
  }
}

const LOCK_METADATA_READ_ATTEMPTS = 4;
const LOCK_METADATA_RETRY_DELAY_MS = 25;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readLockMetadataWithRetry(
  path: string,
): Promise<LockMetadata | undefined> {
  let lastError: LockUncertainError | undefined;
  for (let attempt = 0; attempt < LOCK_METADATA_READ_ATTEMPTS; attempt += 1) {
    try {
      return await readLockMetadata(path);
    } catch (error) {
      if (!(error instanceof LockUncertainError)) throw error;
      lastError = error;
      if (attempt < LOCK_METADATA_READ_ATTEMPTS - 1) {
        await delay(LOCK_METADATA_RETRY_DELAY_MS);
      }
    }
  }
  throw lastError ?? new LockUncertainError("Cannot inspect the lock metadata.");
}

export async function readLockMetadata(
  path: string,
): Promise<LockMetadata | undefined> {
  const raw = await readLockFile(path);
  if (raw === undefined) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new LockUncertainError(
      `The lock file at ${path} contains malformed JSON. Inspect and remove it manually if no owner is active.`,
      { cause: error },
    );
  }

  try {
    return parseLockMetadata(parsed);
  } catch (error) {
    if (error instanceof LockUncertainError) {
      throw new LockUncertainError(
        `The lock file at ${path} is not valid owner metadata: ${error.message} Inspect it manually before removing it.`,
        { cause: error },
      );
    }
    throw error;
  }
}

export async function classifyLockOwner(
  metadata: LockMetadata,
  options: ProcOptions = {},
): Promise<LockOwnerStatus> {
  let currentBootId: string;
  try {
    const current = await getCurrentProcessIdentity(options);
    currentBootId = current.bootId;
  } catch (error) {
    return {
      state: "uncertain",
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  if (metadata.bootId !== currentBootId) {
    return { state: "stale", reason: "boot-id-changed" };
  }

  let ticks: number | undefined;
  try {
    ticks = await readProcessStartTicks(metadata.pid, options);
  } catch (error) {
    return {
      state: "uncertain",
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  if (ticks === undefined) {
    return { state: "stale", reason: "process-missing" };
  }
  if (ticks !== metadata.procStartTicks) {
    return { state: "stale", reason: "process-reused" };
  }
  return { state: "active" };
}

async function syncDirectory(dir: string): Promise<void> {
  if (process.platform === "win32") return;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(dir, "r");
    await handle.sync();
  } catch (error) {
    if (isIgnorableSyncError(error)) return;
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function tryCreateLockFile(
  path: string,
  metadata: LockMetadata,
): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "wx", PRIVATE_FILE_MODE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw new LockError(`Cannot create the lock file at ${path}.`, { cause: error });
  }

  let complete = false;
  let created: { readonly dev: number; readonly ino: number } | undefined;
  try {
    const info = await handle.stat();
    created = { dev: info.dev, ino: info.ino };
    await handle.writeFile(`${JSON.stringify(metadata, null, 2)}\n`);
    await handle.sync();
    complete = true;
  } finally {
    await handle.close().catch(() => undefined);
    if (!complete && created) {
      try {
        const current = await lstat(path);
        if (current.dev === created.dev && current.ino === created.ino) {
          await unlink(path);
        }
      } catch {
        // Leave an uncertain partial file for manual inspection.
      }
    }
  }

  await syncDirectory(dirname(path));
  return true;
}

async function restoreLock(tombstone: string, path: string): Promise<void> {
  try {
    await link(tombstone, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new LockUncertainError(
        `A competing lock appeared at ${path} while reclaiming ${basename(tombstone)}. The preserved copy is at ${tombstone}; inspect both manually.`,
        { cause: error },
      );
    }
    throw new LockUncertainError(
      `Could not restore the lock from ${tombstone} to ${path}; inspect it manually.`,
      { cause: error },
    );
  }

  await unlink(tombstone).catch(() => undefined);
}

async function reclaimStaleLock(
  path: string,
  expected: LockMetadata,
): Promise<void> {
  const tombstone = join(
    dirname(path),
    `.${basename(path)}.stale-${randomUUID()}`,
  );

  try {
    await rename(path, tombstone);
  } catch (error) {
    if (isNotFound(error)) return;
    throw new LockUncertainError(
      `Cannot move the stale lock at ${path} for safe reclamation.`,
      { cause: error },
    );
  }

  let actual: LockMetadata | undefined;
  try {
    const raw = await readLockFile(tombstone);
    if (raw !== undefined) {
      actual = parseLockMetadata(JSON.parse(raw));
    }
  } catch {
    actual = undefined;
  }

  if (actual === undefined || !sameOwner(actual, expected)) {
    await restoreLock(tombstone, path);
    throw new LockUncertainError(
      `The lock at ${path} changed while it was being reclaimed. No stale file was deleted.`,
    );
  }

  try {
    await unlink(tombstone);
    await syncDirectory(dirname(path));
  } catch (error) {
    throw new LockUncertainError(
      `Reclaimed the stale lock at ${path}, but could not remove ${tombstone}.`,
      { cause: error },
    );
  }
}

async function removeOwnedLock(
  path: string,
  expected: LockMetadata,
): Promise<void> {
  const tombstone = join(
    dirname(path),
    `.${basename(path)}.release-${randomUUID()}`,
  );

  try {
    await rename(path, tombstone);
  } catch (error) {
    if (isNotFound(error)) {
      throw new LockOwnershipError(
        `The lock at ${path} disappeared before it could be released.`,
        { cause: error },
      );
    }
    throw new LockOwnershipError(
      `Cannot move the lock at ${path} for verified release.`,
      { cause: error },
    );
  }

  let actual: LockMetadata | undefined;
  try {
    const raw = await readLockFile(tombstone);
    if (raw !== undefined) {
      actual = parseLockMetadata(JSON.parse(raw));
    }
  } catch {
    actual = undefined;
  }

  if (actual === undefined || !sameOwner(actual, expected)) {
    await restoreLock(tombstone, path);
    throw new LockOwnershipError(
      `Refusing to release ${path}: the lock no longer belongs to this owner.`,
    );
  }

  try {
    await unlink(tombstone);
    await syncDirectory(dirname(path));
  } catch (error) {
    throw new LockOwnershipError(
      `Released the lock at ${path}, but could not remove ${tombstone}.`,
      { cause: error },
    );
  }
}

const EXIT_LOCKS_KEY = Symbol.for("ai-browser-agent-lab.lock-exit-registry");

interface ExitLockRegistry {
  readonly locks: Set<OwnerLock>;
  installed: boolean;
}

function exitLockRegistry(): ExitLockRegistry {
  const host = globalThis as typeof globalThis & Record<symbol, unknown>;
  const existing = host[EXIT_LOCKS_KEY] as ExitLockRegistry | undefined;
  if (existing) return existing;
  const created: ExitLockRegistry = { locks: new Set(), installed: false };
  host[EXIT_LOCKS_KEY] = created;
  return created;
}

function registerExitRelease(lock: OwnerLock): void {
  const registry = exitLockRegistry();
  registry.locks.add(lock);
  if (registry.installed) return;
  registry.installed = true;
  process.once("exit", () => {
    for (const registered of registry.locks) {
      registered.releaseSync();
    }
  });
}

export class OwnerLock {
  readonly path: string;
  readonly metadata: LockMetadata;
  private released = false;

  constructor(path: string, metadata: LockMetadata) {
    this.path = path;
    this.metadata = metadata;
  }

  get ownerId(): string {
    return this.metadata.ownerId;
  }

  isReleased(): boolean {
    return this.released;
  }

  async release(): Promise<void> {
    if (this.released) return;
    await removeOwnedLock(this.path, this.metadata);
    exitLockRegistry().locks.delete(this);
    this.released = true;
  }

  releaseSync(): void {
    if (this.released) return;
    try {
      const parsed = parseLockMetadata(JSON.parse(readFileSync(this.path, "utf8")));
      if (!sameOwner(parsed, this.metadata)) return;
      unlinkSync(this.path);
      this.released = true;
      exitLockRegistry().locks.delete(this);
      return;
    } catch {
      // The async path or external cleanup may already have removed or replaced it.
    }

    if (existsSync(this.path)) return;
    this.removeReleaseTombstones();
    this.released = true;
    exitLockRegistry().locks.delete(this);
  }

  private removeReleaseTombstones(): void {
    const dir = dirname(this.path);
    const prefix = `.${basename(this.path)}.release-`;
    try {
      for (const name of readdirSync(dir)) {
        if (!name.startsWith(prefix)) continue;
        const tombstone = join(dir, name);
        try {
          const parsed = parseLockMetadata(
            JSON.parse(readFileSync(tombstone, "utf8")),
          );
          if (sameOwner(parsed, this.metadata)) unlinkSync(tombstone);
        } catch {
          // Leave foreign or malformed tombstones untouched.
        }
      }
    } catch {
      // The directory may be gone during cleanup.
    }
  }
}

export async function acquireLock(
  storage: Storage,
  segments: readonly string[],
  options: AcquireLockOptions,
): Promise<OwnerLock> {
  if (segments.length === 0) {
    throw new LockConfigError("A lock file path is required.");
  }
  if (!isNonEmptyString(options.kind, 64)) {
    throw new LockConfigError("Lock kind must be a non-empty string.");
  }
  if (options.ownerId !== undefined && !isNonEmptyString(options.ownerId, 128)) {
    throw new LockConfigError("Lock ownerId must be a non-empty string.");
  }

  const maxAttempts = options.maxAttempts ?? 5;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new LockConfigError("maxAttempts must be a positive integer.");
  }

  const identity = await getCurrentProcessIdentity({ procRoot: options.procRoot });
  const metadata: LockMetadata = {
    version: LOCK_VERSION,
    kind: options.kind,
    ownerId: options.ownerId ?? randomUUID(),
    pid: identity.pid,
    procStartTicks: identity.procStartTicks,
    bootId: identity.bootId,
    acquiredAt: (options.now?.() ?? new Date()).toISOString(),
  };

  await storage.ensureDir(segments.slice(0, -1));
  const path = storage.path(segments);

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (await tryCreateLockFile(path, metadata)) {
      const lock = new OwnerLock(path, metadata);
      if (options.releaseOnExit) registerExitRelease(lock);
      return lock;
    }

    let existing: LockMetadata | undefined;
    try {
      existing = await readLockMetadataWithRetry(path);
    } catch (error) {
      if (error instanceof LockUncertainError) throw error;
      throw new LockUncertainError(
        `Cannot inspect the existing lock at ${path}.`,
        { cause: error },
      );
    }
    if (existing === undefined) continue;

    const status = await classifyLockOwner(existing, {
      procRoot: options.procRoot,
    });
    if (status.state === "active") {
      throw new LockHeldError(
        `Another process already holds ${path} (${existing.kind}, pid ${existing.pid}, owner ${existing.ownerId}). Stop it before starting another server on this data directory.`,
        existing,
      );
    }
    if (status.state === "uncertain") {
      throw new LockUncertainError(
        `Cannot prove that the lock at ${path} is stale (${status.reason}). Leaving it untouched; inspect it manually.`,
      );
    }
    await reclaimStaleLock(path, existing);
  }

  throw new LockUncertainError(
    `Could not acquire ${path} after ${maxAttempts} attempts because a competing process kept changing the lock.`,
  );
}
