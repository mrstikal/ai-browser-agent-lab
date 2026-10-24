import { invalidateAgentCompatibility } from "./agent-compatibility";
import { normalizeOpenRouterKey } from "./openrouter";
import { assertNoActivePaidOperation } from "./paid-operation";
import { createStorage, Storage, type StorageEnv } from "./storage";

export const OPENROUTER_KEY_SEGMENTS = ["secrets", "openrouter-key"] as const;

export type KeySource = "memory" | "file";

export interface KeyStatus {
  readonly keyAvailable: boolean;
  readonly source: KeySource | null;
}

export interface KeyStatusOptions {
  /**
   * Read-only callers (status pages) set this false so a GET never deletes
   * crash-leftover temp files; key changes still sweep them.
   */
  readonly sweepTemps?: boolean | undefined;
}

export class CredentialError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CredentialError";
  }
}

const CREDENTIAL_HOLDER_KEY = Symbol.for(
  "ai-browser-agent-lab.credential-holder",
);

interface CredentialHolder {
  key?: string | undefined;
  source?: KeySource | undefined;
  loaded: boolean;
  loadPromise?: Promise<void> | undefined;
}

const KEY_TEMP_PATTERN = /^\.openrouter-key\..+\.tmp$/;

/**
 * Removes crash leftovers from Node's atomic-write temp files, which can still
 * contain key material even after the canonical key file is replaced or
 * deleted. Errors propagate: leftover secret material must be visible.
 */
async function sweepKeyTemps(storage: Storage): Promise<void> {
  const names = await storage.listFiles(["secrets"]);
  for (const name of names) {
    if (!KEY_TEMP_PATTERN.test(name)) continue;
    await storage.deleteFile(["secrets", name]);
  }
}

function holder(): CredentialHolder {
  const host = globalThis as typeof globalThis & Record<symbol, unknown>;
  const existing = host[CREDENTIAL_HOLDER_KEY] as CredentialHolder | undefined;
  if (existing) return existing;
  const created: CredentialHolder = { loaded: false };
  host[CREDENTIAL_HOLDER_KEY] = created;
  return created;
}

async function ensureLoaded(
  env: StorageEnv,
  options: KeyStatusOptions = {},
): Promise<void> {
  const state = holder();
  if (state.loaded) return;
  if (state.loadPromise) return state.loadPromise;

  const load = (async () => {
    const storage = createStorage(env);
    if (options.sweepTemps !== false) await sweepKeyTemps(storage);
    const buffer = await storage.readFile(OPENROUTER_KEY_SEGMENTS);

    // A setter or delete may have completed while the read was in flight; it
    // owns the final state and must not be overwritten by this load.
    const current = holder();
    if (current.loaded) return;

    if (buffer !== undefined) {
      const text = buffer.toString("utf8").trim();
      if (text.length > 0) {
        try {
          current.key = normalizeOpenRouterKey(text);
        } catch (error) {
          throw new CredentialError(
            "The stored OpenRouter key is malformed. Delete it and enter the key again.",
            { cause: error },
          );
        }
        current.source = "file";
      }
    }
    current.loaded = true;
  })();

  state.loadPromise = load;
  try {
    await load;
  } finally {
    if (holder().loadPromise === load) {
      holder().loadPromise = undefined;
    }
  }
}

/**
 * Server-only accessor. Never send its result to a client route.
 */
export function getOpenRouterKey(): string | undefined {
  return holder().key;
}

export async function loadOpenRouterKey(
  env: StorageEnv = process.env,
): Promise<string | undefined> {
  await ensureLoaded(env);
  return holder().key;
}

export async function getKeyStatus(
  env: StorageEnv = process.env,
  options: KeyStatusOptions = {},
): Promise<KeyStatus> {
  await ensureLoaded(env, options);
  const state = holder();
  if (!state.key) return { keyAvailable: false, source: null };
  return { keyAvailable: true, source: state.source ?? "memory" };
}

export interface SetOpenRouterKeyOptions {
  readonly remember: boolean;
  readonly env?: StorageEnv | undefined;
  readonly storage?: Storage | undefined;
}

/**
 * Replaces the process key. The model-verification record is invalidated first;
 * if that fails, or a disk write/delete fails, the previous key state is kept.
 * Refuses while a paid operation is active.
 */
export async function setOpenRouterKey(
  key: string,
  options: SetOpenRouterKeyOptions,
): Promise<KeyStatus> {
  const normalized = normalizeOpenRouterKey(key);
  assertNoActivePaidOperation();

  const storage = options.storage ?? createStorage(options.env ?? process.env);
  await invalidateAgentCompatibility(storage);

  const state = holder();
  if (options.remember) {
    await storage.writeFile(OPENROUTER_KEY_SEGMENTS, normalized);
    state.key = normalized;
    state.source = "file";
    state.loaded = true;
    await sweepKeyTemps(storage);
    return { keyAvailable: true, source: "file" };
  }

  await storage.deleteFile(OPENROUTER_KEY_SEGMENTS);
  state.key = normalized;
  state.source = "memory";
  state.loaded = true;
  await sweepKeyTemps(storage);
  return { keyAvailable: true, source: "memory" };
}

// Test-only: drops the process holder so each test starts from no key.
export function resetCredentialHolderForTests(): void {
  const state = holder();
  state.key = undefined;
  state.source = undefined;
  state.loaded = false;
}

export interface DeleteOpenRouterKeyOptions {
  readonly env?: StorageEnv | undefined;
  readonly storage?: Storage | undefined;
}

/**
 * Deletes the key from memory and from disk. The model-verification record is
 * invalidated first; if that or the disk delete fails, the key is untouched.
 * Refuses while a paid operation is active.
 */
export async function deleteOpenRouterKey(
  options: DeleteOpenRouterKeyOptions = {},
): Promise<KeyStatus> {
  assertNoActivePaidOperation();

  const storage = options.storage ?? createStorage(options.env ?? process.env);
  await invalidateAgentCompatibility(storage);
  await storage.deleteFile(OPENROUTER_KEY_SEGMENTS);

  const state = holder();
  state.key = undefined;
  state.source = undefined;
  state.loaded = true;
  await sweepKeyTemps(storage);
  return { keyAvailable: false, source: null };
}
