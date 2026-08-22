import test from "node:test";
import assert from "node:assert/strict";

import { AtomicStore, type AtomicStoreFs } from "./atomicStore";
import { isEngineError } from "./errors";

interface Doc {
  count: number;
  label: string;
}

function parseDoc(value: unknown): Doc {
  if (typeof value !== "object" || value === null) throw new Error("not an object");
  const record = value as Record<string, unknown>;
  if (typeof record.count !== "number" || typeof record.label !== "string") throw new Error("bad shape");
  return { count: record.count, label: record.label };
}

type FaultPoint = "writeFile" | "fsync" | "rename" | "readFile" | "unlink" | "fsyncDir";

class FakeFs implements AtomicStoreFs {
  files = new Map<string, string>();
  fsyncedPaths = new Set<string>();
  fsyncedDirs = new Set<string>();
  faults = new Set<FaultPoint>();
  faultOnce = new Set<FaultPoint>();
  /** Set of exact paths whose *next* readFile() call returns corrupt garbage instead of the real stored content -- simulates a truncated/corrupted write-back read without touching what was actually persisted. */
  corruptNextReadOf = new Set<string>();
  /** Only fail readFile/unlink when the path matches this predicate (defaults to "always", for faults that should apply regardless of which path is touched). */
  readFileFailPredicate: (path: string) => boolean = () => true;
  unlinkFailPredicate: (path: string) => boolean = () => true;

  private maybeFail(point: FaultPoint) {
    if (this.faults.has(point) || this.faultOnce.delete(point)) {
      throw new Error(`injected failure at ${point}`);
    }
  }

  async readFile(path: string): Promise<string> {
    if (this.corruptNextReadOf.has(path)) {
      this.corruptNextReadOf.delete(path);
      return "{not-valid-json-after-all";
    }
    if ((this.faults.has("readFile") || this.faultOnce.has("readFile")) && this.readFileFailPredicate(path)) {
      this.faultOnce.delete("readFile");
      throw new Error(`injected failure at readFile: ${path}`);
    }
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`ENOENT: ${path}`);
    return value;
  }

  async writeFile(path: string, contents: string): Promise<void> {
    this.maybeFail("writeFile");
    this.files.set(path, contents);
  }

  async rename(fromPath: string, toPath: string): Promise<void> {
    this.maybeFail("rename");
    const value = this.files.get(fromPath);
    if (value === undefined) throw new Error(`ENOENT rename source: ${fromPath}`);
    this.files.set(toPath, value);
    this.files.delete(fromPath);
  }

  async unlink(path: string): Promise<void> {
    if ((this.faults.has("unlink") || this.faultOnce.has("unlink")) && this.unlinkFailPredicate(path)) {
      this.faultOnce.delete("unlink");
      throw new Error(`injected failure at unlink: ${path}`);
    }
    if (!this.files.has(path)) throw new Error(`ENOENT unlink: ${path}`);
    this.files.delete(path);
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async readdir(dirPath: string): Promise<string[]> {
    const prefix = `${dirPath.replace(/\/+$/, "")}/`;
    const names = new Set<string>();
    for (const key of this.files.keys()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      // Real fs.readdir returns only the immediate child's basename, never a nested relative path.
      names.add(rest.includes("/") ? rest.slice(0, rest.indexOf("/")) : rest);
    }
    return [...names];
  }

  async fsync(path: string): Promise<void> {
    this.maybeFail("fsync");
    this.fsyncedPaths.add(path);
  }

  async fsyncDir(path: string): Promise<void> {
    this.maybeFail("fsyncDir");
    this.fsyncedDirs.add(path);
  }
}

function makeStore(fs: FakeFs) {
  return new AtomicStore<Doc>({ fs, root: "/data/mindmap", fileName: "state.json", schemaVersion: 1, parse: parseDoc });
}

void test("load returns null when no committed file exists yet", async () => {
  const store = makeStore(new FakeFs());
  assert.equal(await store.load(), null);
});

void test("save then load round-trips the exact value", async () => {
  const fs = new FakeFs();
  const store = makeStore(fs);
  await store.save({ count: 1, label: "a" });
  assert.deepEqual(await store.load(), { count: 1, label: "a" });
});

void test("save writes through a temp file and fsyncs it before the atomic rename", async () => {
  const fs = new FakeFs();
  const store = makeStore(fs);
  await store.save({ count: 1, label: "a" });
  assert.equal(fs.files.has("/data/mindmap/state.json"), true);
  assert.equal([...fs.files.keys()].some((k) => k.includes(".atomic-tmp-")), false, "temp file must not survive a successful save");
  assert.equal(fs.fsyncedPaths.size, 1, "exactly the temp file must have been fsynced");
});

void test("a write failure leaves previously committed state completely unchanged", async () => {
  const fs = new FakeFs();
  const store = makeStore(fs);
  await store.save({ count: 1, label: "committed" });
  fs.faultOnce.add("writeFile");
  await assert.rejects(() => store.save({ count: 2, label: "attempted" }));
  assert.deepEqual(await store.load(), { count: 1, label: "committed" });
});

void test("an fsync failure leaves previously committed state completely unchanged and cleans up its temp file", async () => {
  const fs = new FakeFs();
  const store = makeStore(fs);
  await store.save({ count: 1, label: "committed" });
  fs.faultOnce.add("fsync");
  await assert.rejects(() => store.save({ count: 2, label: "attempted" }));
  assert.deepEqual(await store.load(), { count: 1, label: "committed" });
  assert.equal([...fs.files.keys()].some((k) => k.includes(".atomic-tmp-")), false);
});

void test("a rename failure leaves previously committed state completely unchanged and cleans up its temp file", async () => {
  const fs = new FakeFs();
  const store = makeStore(fs);
  await store.save({ count: 1, label: "committed" });
  fs.faultOnce.add("rename");
  await assert.rejects(() => store.save({ count: 2, label: "attempted" }));
  assert.deepEqual(await store.load(), { count: 1, label: "committed" });
  assert.equal([...fs.files.keys()].some((k) => k.includes(".atomic-tmp-")), false);
});

void test("save reads the temp file back and verifies it before renaming (write-back verification)", async () => {
  const fs = new FakeFs();
  const store = makeStore(fs);
  await store.save({ count: 1, label: "a" });
  assert.equal(fs.fsyncedDirs.size, 1, "the parent directory should be fsynced once after the rename, when the seam supports it");
});

void test("a corrupted write-back read leaves previously committed state unchanged and removes only the temp file", async () => {
  const fs = new FakeFs();
  const store = makeStore(fs);
  await store.save({ count: 1, label: "committed" });

  // Corrupt only the *next* read of whatever temp path this save() writes -- the actually
  // persisted bytes are untouched; only the write-back verification read sees garbage.
  const originalWriteFile = fs.writeFile.bind(fs);
  fs.writeFile = async (path: string, contents: string) => {
    await originalWriteFile(path, contents);
    if (path.includes(".atomic-tmp-")) {
      fs.corruptNextReadOf.add(path);
    }
  };

  await assert.rejects(
    () => store.save({ count: 2, label: "attempted" }),
    (error: unknown) => isEngineError(error) && error.code === "STORE_WRITE_FAILED",
  );
  assert.deepEqual(await store.load(), { count: 1, label: "committed" });
  assert.equal([...fs.files.keys()].some((k) => k.includes(".atomic-tmp-")), false, "the corrupt temp file must be removed");
});

void test("a read failure on the write-back verification read leaves previously committed state unchanged", async () => {
  const fs = new FakeFs();
  const store = makeStore(fs);
  await store.save({ count: 1, label: "committed" });
  fs.faultOnce.add("readFile");
  await assert.rejects(
    () => store.save({ count: 2, label: "attempted" }),
    (error: unknown) => isEngineError(error) && error.code === "STORE_WRITE_FAILED",
  );
  assert.deepEqual(await store.load(), { count: 1, label: "committed" });
  assert.equal([...fs.files.keys()].some((k) => k.includes(".atomic-tmp-")), false);
});

void test("a fsyncDir failure after a successful rename does not fail save() (the commit is already visible)", async () => {
  const fs = new FakeFs();
  const store = makeStore(fs);
  fs.faultOnce.add("fsyncDir");
  await store.save({ count: 1, label: "a" });
  assert.deepEqual(await store.load(), { count: 1, label: "a" });
});

void test("cleanupStaleTempFiles scans a nested fileName's own parent directory, not always root", async () => {
  const fs = new FakeFs();
  const store = new AtomicStore<Doc>({ fs, root: "/data/mindmap", fileName: "jobs/queue.json", schemaVersion: 1, parse: parseDoc });
  fs.files.set("/data/mindmap/jobs/queue.json.atomic-tmp-stale1", "{}");
  fs.files.set("/data/mindmap/jobs/queue.json.atomic-tmp-stale2", "{}");
  fs.files.set("/data/mindmap/jobs/unrelated-file.json", "{}");
  fs.files.set("/data/mindmap/queue.json.atomic-tmp-wrong-dir", "{}");
  const removed = await store.cleanupStaleTempFiles();
  assert.equal(removed, 2);
  assert.equal(fs.files.has("/data/mindmap/jobs/unrelated-file.json"), true);
  assert.equal(fs.files.has("/data/mindmap/queue.json.atomic-tmp-wrong-dir"), true, "must never touch root-level files for a nested fileName");
});

void test("cleanupStaleTempFiles only counts an entry as removed once unlink actually succeeds", async () => {
  const fs = new FakeFs();
  const store = makeStore(fs);
  fs.files.set("/data/mindmap/state.json.atomic-tmp-stale1", "{}");
  fs.files.set("/data/mindmap/state.json.atomic-tmp-stale2", "{}");
  fs.faults.add("unlink");
  fs.unlinkFailPredicate = (path) => path.endsWith("state.json.atomic-tmp-stale1");
  const removed = await store.cleanupStaleTempFiles();
  assert.equal(removed, 1, "only the temp file whose unlink actually succeeded should be counted");
  assert.equal(fs.files.has("/data/mindmap/state.json.atomic-tmp-stale1"), true, "the file whose unlink failed must remain");
  assert.equal(fs.files.has("/data/mindmap/state.json.atomic-tmp-stale2"), false);
});

void test("cleanupStaleTempFiles removes only this store's own leftover temp files", async () => {
  const fs = new FakeFs();
  const store = makeStore(fs);
  fs.files.set("/data/mindmap/state.json.atomic-tmp-stale1", "{}");
  fs.files.set("/data/mindmap/state.json.atomic-tmp-stale2", "{}");
  fs.files.set("/data/mindmap/unrelated-file.json", "{}");
  const removed = await store.cleanupStaleTempFiles();
  assert.equal(removed, 2);
  assert.equal(fs.files.has("/data/mindmap/unrelated-file.json"), true, "must never touch a file outside its own temp-name convention");
});

void test("load fails closed on corrupt JSON", async () => {
  const fs = new FakeFs();
  fs.files.set("/data/mindmap/state.json", "{not json");
  const store = makeStore(fs);
  await assert.rejects(() => store.load(), (error: unknown) => isEngineError(error) && error.code === "STORE_SCHEMA_INVALID");
});

void test("load fails closed on schema version mismatch rather than reinterpreting", async () => {
  const fs = new FakeFs();
  fs.files.set("/data/mindmap/state.json", JSON.stringify({ schemaVersion: 2, data: { count: 1, label: "a" } }));
  const store = makeStore(fs);
  await assert.rejects(() => store.load(), (error: unknown) => isEngineError(error) && error.code === "STORE_SCHEMA_INVALID");
});

void test("load fails closed when the persisted data fails strict shape validation", async () => {
  const fs = new FakeFs();
  fs.files.set("/data/mindmap/state.json", JSON.stringify({ schemaVersion: 1, data: { count: "not a number", label: "a" } }));
  const store = makeStore(fs);
  await assert.rejects(() => store.load(), (error: unknown) => isEngineError(error) && error.code === "STORE_SCHEMA_INVALID");
});

void test("load fails closed on a bounded read that exceeds maxBytes", async () => {
  const fs = new FakeFs();
  const store = new AtomicStore<Doc>({ fs, root: "/data/mindmap", fileName: "state.json", schemaVersion: 1, parse: parseDoc, maxBytes: 16 });
  fs.files.set("/data/mindmap/state.json", JSON.stringify({ schemaVersion: 1, data: { count: 1, label: "much too long for the bound" } }));
  await assert.rejects(() => store.load(), (error: unknown) => isEngineError(error) && error.code === "STORE_READ_FAILED");
});

void test("save refuses a fileName that would escape the owned root via traversal", () => {
  const fs = new FakeFs();
  assert.throws(
    () => new AtomicStore<Doc>({ fs, root: "/data/mindmap", fileName: "../outside.json", schemaVersion: 1, parse: parseDoc }),
    (error: unknown) => isEngineError(error) && error.code === "STORE_PATH_INVALID",
  );
});

void test("save refuses an absolute fileName", () => {
  const fs = new FakeFs();
  assert.throws(
    () => new AtomicStore<Doc>({ fs, root: "/data/mindmap", fileName: "/etc/passwd", schemaVersion: 1, parse: parseDoc }),
    (error: unknown) => isEngineError(error) && error.code === "STORE_PATH_INVALID",
  );
});

void test("save refuses to persist a value that fails its own parser", async () => {
  const fs = new FakeFs();
  const store = makeStore(fs);
  const bad = { count: Number.NaN, label: "a" } as unknown as Doc;
  // NaN round-trips through JSON.stringify as null, so parseDoc rejects it -- proving save() re-validates rather than trusting the caller's static type.
  await assert.rejects(() => store.save(bad), (error: unknown) => isEngineError(error) && error.code === "STORE_SCHEMA_INVALID");
  assert.equal(fs.files.has("/data/mindmap/state.json"), false);
});

void test("ten repeated save/load cycles are idempotent and never leak temp files", async () => {
  const fs = new FakeFs();
  const store = makeStore(fs);
  for (let i = 0; i < 10; i += 1) {
    await store.save({ count: i, label: `cycle-${i}` });
  }
  assert.deepEqual(await store.load(), { count: 9, label: "cycle-9" });
  assert.equal([...fs.files.keys()].filter((k) => k.includes(".atomic-tmp-")).length, 0);
  assert.equal(fs.files.size, 1, "only the single committed state file should remain");
});
