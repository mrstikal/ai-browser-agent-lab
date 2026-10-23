import { afterEach, describe, expect, it } from "vitest";
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse, resolve } from "node:path";
import {
  DEFAULT_MAX_JSONL_RECORD_BYTES,
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE,
  Storage,
  StorageConfigError,
  StorageCorruptionError,
  StorageExistsError,
  StorageLimitError,
  StoragePathError,
  createStorage,
  resolveDataRoot,
} from "../src/server/storage";

const tempDirs: string[] = [];

async function makeBase(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ai-browser-lab-storage-"));
  tempDirs.push(dir);
  return dir;
}

async function makeStorage(): Promise<Storage> {
  return new Storage(join(await makeBase(), "data"));
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("storage foundation", () => {
  it("creates private directories and writes JSON/binary files lazily", async () => {
    const root = join(await makeBase(), "data");
    const storage = new Storage(root);
    await expect(stat(root)).rejects.toMatchObject({ code: "ENOENT" });

    await storage.writeJson(["settings.json"], { theme: "light", count: 2 });
    await storage.writeFile(["images", "P01-test.png"], new Uint8Array([1, 2, 3]));

    expect(await storage.readJson(["settings.json"])).toEqual({
      theme: "light",
      count: 2,
    });
    const image = await storage.readFile(["images", "P01-test.png"]);
    expect(image).toBeDefined();
    expect(Array.from(image ?? [])).toEqual([1, 2, 3]);

    if (process.platform !== "win32") {
      expect((await stat(root)).mode & 0o777).toBe(PRIVATE_DIR_MODE);
      expect((await stat(join(root, "settings.json"))).mode & 0o777).toBe(
        PRIVATE_FILE_MODE,
      );
      expect((await stat(join(root, "images"))).mode & 0o777).toBe(PRIVATE_DIR_MODE);
      expect((await stat(join(root, "images", "P01-test.png"))).mode & 0o777).toBe(
        PRIVATE_FILE_MODE,
      );
    }
  });

  it("returns missing values without creating the root", async () => {
    const root = join(await makeBase(), "data");
    const storage = new Storage(root);
    expect(await storage.readJson(["settings.json"])).toBeUndefined();
    expect(await storage.readJsonLines(["events.jsonl"])).toEqual({
      records: [],
      truncated: false,
    });
    expect(await storage.readFile(["image.png"])).toBeUndefined();
    await expect(stat(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects unsafe path segments", async () => {
    const storage = await makeStorage();
    for (const segments of [
      ["..", "escape"],
      ["images", "..", "escape"],
      ["/etc/passwd"],
      ["images/../../escape"],
      ["images\\..\\escape"],
      [""],
      ["."],
      [".."],
      ["bad\0name"],
    ]) {
      expect(() => storage.path(segments)).toThrow(StoragePathError);
    }
    expect(storage.path([])).toBe(storage.root);
    expect(storage.path(["..foo"])).toBe(join(storage.root, "..foo"));
    expect(storage.path(["images", "P01.png"])).toBe(
      join(storage.root, "images", "P01.png"),
    );
  });

  it("writes a file exclusively without replacing an existing target", async () => {
    const storage = await makeStorage();
    await storage.writeFileExclusive(["images", "P01-attempt.png"], "first");
    expect(await storage.readFile(["images", "P01-attempt.png"])).toEqual(
      Buffer.from("first"),
    );

    await expect(
      storage.writeFileExclusive(["images", "P01-attempt.png"], "second"),
    ).rejects.toThrow(StorageExistsError);
    expect(await storage.readFile(["images", "P01-attempt.png"])).toEqual(
      Buffer.from("first"),
    );
    if (process.platform !== "win32") {
      expect(
        (await stat(storage.path(["images", "P01-attempt.png"]))).mode & 0o777,
      ).toBe(0o600);
    }
  });

  it("deletes files idempotently and reports missing paths", async () => {
    const storage = await makeStorage();
    expect(await storage.deleteFile(["secrets", "openrouter-key"])).toBe(false);

    await storage.writeFile(["secrets", "openrouter-key"], "sk-or-v1-test");
    const target = storage.path(["secrets", "openrouter-key"]);
    expect((await stat(target)).isFile()).toBe(true);

    expect(await storage.deleteFile(["secrets", "openrouter-key"])).toBe(true);
    expect(await storage.readFile(["secrets", "openrouter-key"])).toBeUndefined();
    expect(await storage.deleteFile(["secrets", "openrouter-key"])).toBe(false);
  });

  it("lists regular files safely and ignores missing directories", async () => {
    const storage = await makeStorage();
    expect(await storage.listFiles(["secrets"])).toEqual([]);

    await storage.writeFile(["secrets", "b.txt"], "b");
    await storage.writeFile(["secrets", "a.txt"], "a");
    await mkdir(storage.path(["secrets", "nested"]));
    expect(await storage.listFiles(["secrets"])).toEqual(["a.txt", "b.txt"]);
    await expect(storage.listFiles([])).rejects.toThrow(StoragePathError);
  });

  it.skipIf(process.platform === "win32")(
    "does not list symlinks as regular files", async () => {
      const base = await makeBase();
      const storage = new Storage(join(base, "data"));
      await storage.writeFile(["secrets", "real.txt"], "real");
      await symlink(
        storage.path(["secrets", "real.txt"]),
        storage.path(["secrets", "link.txt"]),
      );

      expect(await storage.listFiles(["secrets"])).toEqual(["real.txt"]);
    },
  );

  it.skipIf(process.platform === "win32")(
    "refuses to delete symlinks or directories", async () => {
      const base = await makeBase();
      const storage = new Storage(join(base, "data"));
      await storage.ensureDir([]);
      const outside = join(base, "outside.txt");
      await writeFile(outside, "keep");
      await symlink(outside, join(storage.root, "link.txt"));
      await mkdir(storage.path(["a-directory"]));

      await expect(storage.deleteFile(["link.txt"])).rejects.toThrow(
        StoragePathError,
      );
      await expect(storage.deleteFile(["a-directory"])).rejects.toThrow(
        StoragePathError,
      );
      expect(await readFile(outside, "utf8")).toBe("keep");
      expect((await stat(storage.path(["a-directory"]))).isDirectory()).toBe(true);
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects symlinked directories inside the data root",
    async () => {
      const base = await makeBase();
      const storage = new Storage(join(base, "data"));
      await storage.ensureDir([]);
      const outside = join(base, "outside");
      await mkdir(outside);
      await symlink(outside, join(storage.root, "images"), "dir");

      await expect(
        storage.writeJson(["images", "manifest.json"], { ok: true }),
      ).rejects.toThrow(StoragePathError);
      expect(await readdir(outside)).toEqual([]);
    },
  );

  it("resolves DATA_DIR and rejects unsafe roots", async () => {
    const root = join(await makeBase(), "isolated-data");
    expect(resolveDataRoot({ DATA_DIR: root })).toBe(root);
    expect(resolveDataRoot({})).toBe(resolve(process.cwd(), "data"));
    expect(resolveDataRoot({ DATA_DIR: "relative-data" })).toBe(
      resolve(process.cwd(), "relative-data"),
    );

    for (const value of ["", "   ", ".", "public/data", parse(process.cwd()).root]) {
      expect(() => resolveDataRoot({ DATA_DIR: value })).toThrow(StorageConfigError);
    }
    expect(() => new Storage(parse(process.cwd()).root)).toThrow(StorageConfigError);

    const storage = createStorage({ DATA_DIR: root });
    await storage.writeJson(["settings.json"], { ok: true });
    expect(await storage.readJson(["settings.json"])).toEqual({ ok: true });
  });

  it.skipIf(process.platform === "win32")(
    "does not chmod a pre-existing directory",
    async () => {
      const base = await makeBase();
      const root = join(base, "data");
      await mkdir(root);
      await chmod(root, 0o755);
      const storage = new Storage(root);

      await storage.writeJson(["settings.json"], { ok: true });
      expect((await stat(root)).mode & 0o777).toBe(0o755);
    },
  );

  it("keeps concurrent JSON writes atomic", async () => {
    const storage = await makeStorage();
    const values = Array.from({ length: 20 }, (_, index) => ({
      index,
      payload: "x".repeat(1000),
    }));
    await Promise.all(
      values.map((value) => storage.writeJson(["settings.json"], value)),
    );

    const result = await storage.readJson<{ index: number; payload: string }>([
      "settings.json",
    ]);
    expect(result).toBeDefined();
    expect(values.some((value) => value.index === result?.index)).toBe(true);
    expect(result?.payload).toHaveLength(1000);
    expect((await readdir(storage.root)).filter((name) => name.endsWith(".tmp"))).toEqual(
      [],
    );
  });

  it("never exposes a partially written JSON snapshot", async () => {
    const storage = await makeStorage();
    await storage.writeJson(["settings.json"], { version: 0 });
    const writes = Array.from({ length: 20 }, (_, index) =>
      storage.writeJson(["settings.json"], { version: index + 1 }),
    );
    const reads = Array.from({ length: 20 }, () =>
      storage.readJson<{ version: number }>(["settings.json"]),
    );
    const results = await Promise.all(reads);
    for (const result of results) {
      expect(result).toBeDefined();
      expect(Number.isInteger(result?.version)).toBe(true);
    }
    await Promise.all(writes);
  });

  it("appends concurrent JSONL records without corrupting the log", async () => {
    const storage = await makeStorage();
    const count = 40;
    await Promise.all(
      Array.from({ length: count }, (_, index) =>
        storage.appendJsonLine(["events.jsonl"], { index }),
      ),
    );

    const result = await storage.readJsonLines<{ index: number }>(["events.jsonl"]);
    expect(result.truncated).toBe(false);
    expect(result.records).toHaveLength(count);
    expect(new Set(result.records.map((record) => record.index)).size).toBe(count);
    expect(result.records.map((record) => record.index).sort((a, b) => a - b)).toEqual(
      Array.from({ length: count }, (_, index) => index),
    );
  });

  it("leaves a valid file intact when serialization fails", async () => {
    const storage = await makeStorage();
    await storage.writeJson(["settings.json"], { version: 1 });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(storage.writeJson(["settings.json"], circular)).rejects.toThrow();
    expect(await storage.readJson(["settings.json"])).toEqual({ version: 1 });
    expect((await readdir(storage.root)).filter((name) => name.endsWith(".tmp"))).toEqual(
      [],
    );
  });

  it("cleans temporary files when the final rename fails", async () => {
    const storage = await makeStorage();
    await storage.ensureDir(["occupied"]);
    await expect(storage.writeJson(["occupied"], { ok: true })).rejects.toThrow();
    expect((await stat(join(storage.root, "occupied"))).isDirectory()).toBe(true);
    expect((await readdir(storage.root)).filter((name) => name.endsWith(".tmp"))).toEqual(
      [],
    );
  });

  it("does not replace a valid file when a parent path is a file", async () => {
    const storage = await makeStorage();
    await storage.writeJson(["blocked"], { ok: true });
    await expect(
      storage.writeJson(["blocked", "child.json"], { ok: false }),
    ).rejects.toThrow();
    expect(await storage.readJson(["blocked"])).toEqual({ ok: true });
  });

  it("refuses to append after a truncated JSONL tail", async () => {
    const storage = await makeStorage();
    await storage.appendJsonLine(["events.jsonl"], { index: 1 });
    const file = storage.path(["events.jsonl"]);
    await appendFile(file, '{"index":2');
    const before = await readFile(file);

    await expect(
      storage.appendJsonLine(["events.jsonl"], { index: 3 }),
    ).rejects.toThrow(StorageCorruptionError);
    expect(await readFile(file)).toEqual(before);
  });

  it("terminates a valid final JSONL record that lacks a newline", async () => {
    const storage = await makeStorage();
    await storage.ensureDir([]);
    const file = storage.path(["events.jsonl"]);
    await writeFile(file, '{"index":1}');

    await storage.appendJsonLine(["events.jsonl"], { index: 2 });
    const result = await storage.readJsonLines<{ index: number }>(["events.jsonl"]);
    expect(result).toEqual({ records: [{ index: 1 }, { index: 2 }], truncated: false });
    expect((await readFile(file, "utf8")).endsWith("\n")).toBe(true);
  });

  it("reports a truncated final JSONL event without modifying the file", async () => {
    const storage = await makeStorage();
    await storage.appendJsonLine(["events.jsonl"], { index: 1 });
    await storage.appendJsonLine(["events.jsonl"], { index: 2 });
    const file = storage.path(["events.jsonl"]);
    await appendFile(file, '{"index":3');
    const before = await readFile(file);

    const result = await storage.readJsonLines<{ index: number }>(["events.jsonl"]);
    expect(result).toEqual({ records: [{ index: 1 }, { index: 2 }], truncated: true });
    expect(await readFile(file)).toEqual(before);
  });

  it("throws an explicit corruption error for malformed middle JSONL lines", async () => {
    const storage = await makeStorage();
    await storage.ensureDir([]);
    await writeFile(
      storage.path(["events.jsonl"]),
      '{"index":1}\nnot-json\n{"index":3}\n',
    );
    await expect(storage.readJsonLines(["events.jsonl"])).rejects.toThrow(
      StorageCorruptionError,
    );
  });

  it("throws an explicit corruption error for malformed JSON snapshots", async () => {
    const storage = await makeStorage();
    await storage.ensureDir([]);
    await writeFile(storage.path(["settings.json"]), "{not json");
    await expect(storage.readJson(["settings.json"])).rejects.toThrow(
      StorageCorruptionError,
    );
  });

  it("rejects oversized JSONL records without touching the log", async () => {
    const storage = await makeStorage();
    await storage.appendJsonLine(["events.jsonl"], { index: 1 });
    const file = storage.path(["events.jsonl"]);
    const before = await readFile(file);
    await expect(
      storage.appendJsonLine(["events.jsonl"], {
        payload: "x".repeat(DEFAULT_MAX_JSONL_RECORD_BYTES),
      }),
    ).rejects.toThrow(StorageLimitError);
    expect(await readFile(file)).toEqual(before);
  });

  it("rejects invalid JSONL limits and undefined JSON values", async () => {
    const storage = await makeStorage();
    await expect(
      storage.appendJsonLine(["events.jsonl"], { index: 1 }, { maxBytes: 0 }),
    ).rejects.toThrow(StorageConfigError);
    await expect(storage.writeJson(["undefined.json"], undefined)).rejects.toThrow(
      TypeError,
    );
    expect(await storage.readFile(["undefined.json"])).toBeUndefined();
  });

  it("preserves crash leftovers beside a valid file and never deletes them", async () => {
    const storage = await makeStorage();
    await storage.writeJson(["settings.json"], { version: 1 });
    const leftover = storage.path([".settings.json.1234.tmp"]);
    await writeFile(leftover, '{"partial":');
    expect(await storage.readJson(["settings.json"])).toEqual({ version: 1 });
    expect(await readFile(leftover, "utf8")).toBe('{"partial":');

    await storage.writeJson(["settings.json"], { version: 2 });
    expect(await storage.readJson(["settings.json"])).toEqual({ version: 2 });
    expect(await readFile(leftover, "utf8")).toBe('{"partial":');
  });
});
