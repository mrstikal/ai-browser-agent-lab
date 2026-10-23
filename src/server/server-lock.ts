import { createStorage, type StorageEnv } from "./storage";
import {
  acquireLock,
  OwnerLock,
  readLockMetadata,
  sameOwner,
  type LockMetadata,
} from "./lock";
import {
  getCurrentProcessIdentity,
  type ProcessIdentity,
} from "./process-identity";

export const SERVER_LOCK_SEGMENTS = [".server.lock"] as const;
export const SERVER_LOCK_KIND = "server";

const SERVER_LOCK_HOLDER_KEY = Symbol.for(
  "ai-browser-agent-lab.server-lock-holder",
);

interface ServerLockHolder {
  root?: string | undefined;
  lock?: OwnerLock | undefined;
  start?: Promise<OwnerLock> | undefined;
}

export class ServerLockError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ServerLockError";
  }
}

function holder(): ServerLockHolder {
  const host = globalThis as typeof globalThis & Record<symbol, unknown>;
  const existing = host[SERVER_LOCK_HOLDER_KEY] as ServerLockHolder | undefined;
  if (existing) return existing;
  const created: ServerLockHolder = {};
  host[SERVER_LOCK_HOLDER_KEY] = created;
  return created;
}

export async function ensureServerLock(
  env: StorageEnv = process.env,
): Promise<OwnerLock> {
  const storage = createStorage(env);
  const root = storage.root;
  const state = holder();

  if (state.lock && !state.lock.isReleased()) {
    if (state.root !== root) {
      throw new ServerLockError(
        "DATA_DIR changed while this process held the server lock. Restart the server with the original data directory.",
      );
    }
    if (!(await isServerLockHeld(env))) {
      throw new ServerLockError(
        "The server lock is no longer owned by this process. Restart the server after inspecting data/.server.lock.",
      );
    }
    return state.lock;
  }

  if (state.start) {
    if (state.root !== root) {
      throw new ServerLockError(
        "DATA_DIR changed while the server lock was being acquired.",
      );
    }
    return state.start;
  }

  state.root = root;
  const start = acquireLock(storage, SERVER_LOCK_SEGMENTS, {
    kind: SERVER_LOCK_KIND,
    releaseOnExit: true,
  });
  state.start = start;

  try {
    const lock = await start;
    state.lock = lock;
    return lock;
  } finally {
    if (state.start === start) {
      state.start = undefined;
    }
  }
}

export async function releaseServerLock(): Promise<void> {
  const state = holder();
  if (state.start) {
    await state.start.catch(() => undefined);
  }

  const lock = state.lock;
  if (!lock) {
    state.root = undefined;
    return;
  }

  try {
    if (!lock.isReleased()) {
      await lock.release();
    }
  } finally {
    state.lock = undefined;
    state.root = undefined;
  }
}

function sameIdentity(left: ProcessIdentity, right: ProcessIdentity): boolean {
  return (
    left.pid === right.pid &&
    left.procStartTicks === right.procStartTicks &&
    left.bootId === right.bootId
  );
}

export async function isServerLockHeld(
  env: StorageEnv = process.env,
): Promise<boolean> {
  const state = holder();
  const lock = state.lock;
  if (!lock || lock.isReleased()) return false;

  let root: string;
  try {
    root = createStorage(env).root;
  } catch {
    return false;
  }
  if (state.root !== root) return false;

  let onDisk: LockMetadata | undefined;
  try {
    onDisk = await readLockMetadata(lock.path);
  } catch {
    return false;
  }
  if (!onDisk || !sameOwner(onDisk, lock.metadata)) return false;
  if (onDisk.pid !== process.pid) return false;

  let current: ProcessIdentity;
  try {
    current = await getCurrentProcessIdentity();
  } catch {
    return false;
  }
  return sameIdentity(onDisk, current);
}

export function heldServerLockMetadata() {
  const lock = holder().lock;
  return lock && !lock.isReleased() ? lock.metadata : undefined;
}
