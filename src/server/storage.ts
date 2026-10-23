import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";

export const DEFAULT_DATA_DIR_NAME = "data";
export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;
export const DEFAULT_MAX_JSONL_RECORD_BYTES = 64 * 1024;

export type StorageEnv = Readonly<Record<string, string | undefined>>;

export interface JsonLineOptions {
  readonly maxBytes?: number;
}

export interface JsonLinesResult<T> {
  readonly records: readonly T[];
  readonly truncated: boolean;
}

export class StorageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StorageError";
  }
}

export class StorageConfigError extends StorageError {
  constructor(message: string) {
    super(message);
    this.name = "StorageConfigError";
  }
}

export class StoragePathError extends StorageError {
  constructor(message: string) {
    super(message);
    this.name = "StoragePathError";
  }
}

export class StorageCorruptionError extends StorageError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StorageCorruptionError";
  }
}

export class StorageLimitError extends StorageError {
  constructor(message: string) {
    super(message);
    this.name = "StorageLimitError";
  }
}

function isPathInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function assertSafeDataRoot(root: string): void {
  if (root === parse(root).root) {
    throw new StorageConfigError("Storage root must not be the filesystem root.");
  }
  const cwd = resolve(process.cwd());
  if (root === cwd) {
    throw new StorageConfigError(
      "Storage root must be a dedicated directory, not the project root.",
    );
  }
  if (isPathInside(resolve(cwd, "public"), root)) {
    throw new StorageConfigError("Storage root must not be inside public/.");
  }
}

export function resolveDataRoot(env: StorageEnv = process.env): string {
  const configured = env.DATA_DIR;
  const raw = configured === undefined ? DEFAULT_DATA_DIR_NAME : configured.trim();
  if (!raw) {
    throw new StorageConfigError("DATA_DIR must not be empty.");
  }
  const root = resolve(process.cwd(), raw);
  assertSafeDataRoot(root);
  return root;
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isIgnorableSyncError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EINVAL" || code === "ENOTSUP" || code === "ENOSYS";
}

async function assertNoSymlinkComponents(root: string, target: string): Promise<void> {
  const rel = relative(root, target);
  if (rel === "") return;
  let current = root;
  for (const part of rel.split(sep)) {
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        throw new StoragePathError(
          `Path component must not be a symbolic link: ${current}.`,
        );
      }
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

async function jsonLinesAppendPrefix(
  target: string,
  maxBytes: number,
): Promise<Buffer> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      target,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    if (isNotFound(error)) return Buffer.alloc(0);
    throw error;
  }

  try {
    const info = await handle.stat();
    if (info.size === 0) return Buffer.alloc(0);

    const start = Math.max(0, info.size - maxBytes - 1);
    const length = info.size - start;
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        length - offset,
        start + offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }

    const text = buffer.subarray(0, offset).toString("utf8");
    if (text.endsWith("\n")) return Buffer.alloc(0);

    const lastNewline = text.lastIndexOf("\n");
    if (start > 0 && lastNewline === -1) {
      throw new StorageCorruptionError(
        `Cannot append to ${target}: the final JSONL record exceeds the read window.`,
      );
    }
    const lastLine = lastNewline >= 0 ? text.slice(lastNewline + 1) : text;
    try {
      JSON.parse(lastLine);
    } catch (error) {
      throw new StorageCorruptionError(
        `Cannot append to ${target}: the final JSONL record is truncated.`,
        { cause: error },
      );
    }
    return Buffer.from("\n");
  } finally {
    await handle.close();
  }
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

export class Storage {
  readonly root: string;

  constructor(root: string) {
    if (typeof root !== "string" || root.trim() === "") {
      throw new StorageConfigError("Storage root must be a non-empty path.");
    }
    const resolved = resolve(root);
    assertSafeDataRoot(resolved);
    this.root = resolved;
  }

  path(segments: readonly string[]): string {
    for (const segment of segments) {
      if (typeof segment !== "string" || segment.length === 0) {
        throw new StoragePathError("Path segments must be non-empty strings.");
      }
      if (segment === "." || segment === "..") {
        throw new StoragePathError(`Unsafe path segment: ${JSON.stringify(segment)}.`);
      }
      if (
        segment.includes("/") ||
        segment.includes("\\") ||
        segment.includes("\0")
      ) {
        throw new StoragePathError(
          `Path segment must not contain separators or NUL: ${JSON.stringify(segment)}.`,
        );
      }
      if (isAbsolute(segment)) {
        throw new StoragePathError(`Path segment must be relative: ${JSON.stringify(segment)}.`);
      }
      if (process.platform === "win32" && segment.includes(":")) {
        throw new StoragePathError(`Path segment must not contain a drive: ${JSON.stringify(segment)}.`);
      }
    }

    const target = resolve(this.root, ...segments);
    const rel = relative(this.root, target);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new StoragePathError("Resolved path escapes the storage root.");
    }
    return target;
  }

  async ensureDir(segments: readonly string[]): Promise<string> {
    const dir = this.path(segments);
    await assertNoSymlinkComponents(this.root, dir);
    const existed = await pathExists(dir);
    await mkdir(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
    await assertNoSymlinkComponents(this.root, dir);
    if (!existed && process.platform !== "win32") {
      await chmod(dir, PRIVATE_DIR_MODE);
    }
    return dir;
  }

  async writeJson(segments: readonly string[], value: unknown): Promise<void> {
    this.requireFileSegments(segments);
    const serialized = JSON.stringify(value, null, 2);
    if (serialized === undefined) {
      throw new TypeError("Cannot serialize undefined as JSON.");
    }
    await this.writeFile(segments, `${serialized}\n`);
  }

  async writeFile(
    segments: readonly string[],
    data: string | Uint8Array,
  ): Promise<void> {
    this.requireFileSegments(segments);
    const target = this.path(segments);
    const dir = await this.ensureDir(segments.slice(0, -1));
    const tempPath = join(dir, `.${basename(target)}.${randomUUID()}.tmp`);
    let tempCreated = false;

    try {
      const handle = await open(tempPath, "wx", PRIVATE_FILE_MODE);
      tempCreated = true;
      try {
        await handle.writeFile(data);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tempPath, target);
      tempCreated = false;
      await syncDirectory(dir);
    } finally {
      if (tempCreated) {
        await unlink(tempPath).catch(() => undefined);
      }
    }
  }

  async readFile(segments: readonly string[]): Promise<Buffer | undefined> {
    this.requireFileSegments(segments);
    const target = this.path(segments);
    await assertNoSymlinkComponents(this.root, target);
    try {
      const handle = await open(
        target,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      try {
        return await handle.readFile();
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  async readJson<T>(segments: readonly string[]): Promise<T | undefined> {
    const buffer = await this.readFile(segments);
    if (buffer === undefined) return undefined;
    try {
      return JSON.parse(buffer.toString("utf8")) as T;
    } catch (error) {
      throw new StorageCorruptionError(
        `Malformed JSON in ${this.path(segments)}.`,
        { cause: error },
      );
    }
  }

  async deleteFile(segments: readonly string[]): Promise<boolean> {
    this.requireFileSegments(segments);
    const target = this.path(segments);
    await assertNoSymlinkComponents(this.root, target);

    let info;
    try {
      info = await lstat(target);
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
    if (!info.isFile()) {
      throw new StoragePathError(
        `Refusing to delete a non-regular file at ${target}.`,
      );
    }

    await unlink(target);
    await syncDirectory(dirname(target));
    return true;
  }

  async listFiles(segments: readonly string[]): Promise<string[]> {
    this.requireFileSegments(segments);
    const dir = this.path(segments);
    await assertNoSymlinkComponents(this.root, dir);
    const entries = await readdir(dir, { withFileTypes: true }).catch(
      (error: unknown) => {
        if (isNotFound(error)) return [] as const;
        throw error;
      },
    );
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();
  }

  async appendJsonLine(
    segments: readonly string[],
    record: unknown,
    options: JsonLineOptions = {},
  ): Promise<void> {
    this.requireFileSegments(segments);
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_JSONL_RECORD_BYTES;
    if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
      throw new StorageConfigError("maxBytes must be a positive integer.");
    }

    const serialized = JSON.stringify(record);
    if (serialized === undefined) {
      throw new TypeError("Cannot serialize undefined as a JSONL record.");
    }
    const recordLine = Buffer.from(`${serialized}\n`, "utf8");
    if (recordLine.byteLength > maxBytes) {
      throw new StorageLimitError(
        `JSONL record is ${recordLine.byteLength} bytes, exceeding the ${maxBytes}-byte limit.`,
      );
    }

    const target = this.path(segments);
    const dir = await this.ensureDir(segments.slice(0, -1));
    const existed = await pathExists(target);
    const prefix = await jsonLinesAppendPrefix(target, maxBytes);
    const flags =
      constants.O_APPEND |
      constants.O_CREAT |
      constants.O_WRONLY |
      (constants.O_NOFOLLOW ?? 0);
    const handle = await open(target, flags, PRIVATE_FILE_MODE);
    try {
      if (process.platform !== "win32") {
        const info = await handle.stat();
        if ((info.mode & 0o777) !== PRIVATE_FILE_MODE) {
          await handle.chmod(PRIVATE_FILE_MODE);
        }
      }
      await handle.writeFile(Buffer.concat([prefix, recordLine]));
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (!existed) {
      await syncDirectory(dir);
    }
  }

  async readJsonLines<T>(
    segments: readonly string[],
  ): Promise<JsonLinesResult<T>> {
    const buffer = await this.readFile(segments);
    if (buffer === undefined) {
      return { records: [], truncated: false };
    }

    const lines = buffer.toString("utf8").split("\n");
    while (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop();
    }

    const records: T[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line === undefined || line === "") continue;
      try {
        records.push(JSON.parse(line) as T);
      } catch (error) {
        if (index === lines.length - 1) {
          return { records, truncated: true };
        }
        throw new StorageCorruptionError(
          `Malformed JSONL at line ${index + 1} in ${this.path(segments)}.`,
          { cause: error },
        );
      }
    }
    return { records, truncated: false };
  }

  private requireFileSegments(segments: readonly string[]): void {
    if (segments.length === 0) {
      throw new StoragePathError("A file path is required.");
    }
  }
}

export function createStorage(env: StorageEnv = process.env): Storage {
  return new Storage(resolveDataRoot(env));
}
