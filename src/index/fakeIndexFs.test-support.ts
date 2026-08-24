import type { IndexFs } from "./indexFs";

/**
 * Shared in-memory, fault-injectable `IndexFs` double for every Checkpoint
 * 5 persistence test (`generationStore.test.ts`, `overlayStore.test.ts`,
 * `indexStore.test.ts`) -- never touches a real filesystem. Mirrors the
 * fault-injection shape `AtomicStore`'s own test double
 * (`engine/atomicStore.test.ts`'s `FakeFs`) already uses (a `faults` set
 * for "every call to this point fails", a `faultOnce` set for "the next
 * call only", and `corruptNextReadOf`/`corruptNextReadBytesOf` for
 * simulating a truncated/corrupt write-back read), extended with `mkdir`,
 * raw byte I/O (`readFileBytes`/`writeFileBytes`/`readFileBytesRange`, in
 * a SEPARATE map from the JSON `files` map -- the two are physically
 * different files on disk in the real layout), and a directory-tree-aware
 * `rename` that moves matching entries out of BOTH maps atomically (real
 * `fs.rename` moves an entire directory, JSON and binary children alike,
 * in one syscall).
 */
export type FaultPoint =
  | "readFile"
  | "writeFile"
  | "rename"
  | "unlink"
  | "fsync"
  | "fsyncDir"
  | "mkdir"
  | "rmdir"
  | "readdir"
  | "readFileBytes"
  | "writeFileBytes"
  | "readFileBytesRange"
  | "statSize";

export class FakeIndexFs implements IndexFs {
  files = new Map<string, string>();
  binaryFiles = new Map<string, Uint8Array>();
  dirs = new Set<string>();
  fsyncedPaths = new Set<string>();
  fsyncedDirs = new Set<string>();
  faults = new Set<FaultPoint>();
  faultOnce = new Set<FaultPoint>();
  /** Set of exact paths whose *next* readFile() call returns corrupt garbage instead of the real stored content. */
  corruptNextReadOf = new Set<string>();
  /** Set of exact paths whose *next* readFileBytes()/readFileBytesRange() call returns bit-flipped garbage of the same length instead of the real stored bytes. */
  corruptNextReadBytesOf = new Set<string>();
  /** Only fail readFile/unlink/rename when the path (source path for rename) matches this predicate. Defaults to "always". */
  pathFailPredicate: (path: string) => boolean = () => true;

  /** When set, a call at `point`/`path` matching this awaits `pauseSignal` (calling `onPaused()` once, the moment it starts waiting) before proceeding -- lets a test deterministically interleave a concurrent read with an in-flight, paused mutation/compaction, without any real timing races. */
  pauseMatcher?: (point: FaultPoint, path: string) => boolean;
  pauseSignal?: Promise<void>;
  onPaused?: () => void;

  private maybeFail(point: FaultPoint, path?: string): void {
    const shouldFail = this.faults.has(point) || this.faultOnce.has(point);
    if (!shouldFail) return;
    if (path !== undefined && !this.pathFailPredicate(path)) return;
    this.faultOnce.delete(point);
    throw new Error(`injected failure at ${point}${path ? `: ${path}` : ""}`);
  }

  private async maybePause(point: FaultPoint, path: string): Promise<void> {
    if (this.pauseMatcher?.(point, path)) {
      this.onPaused?.();
      if (this.pauseSignal) await this.pauseSignal;
    }
  }

  /** Every FULL-file read's path (`readFile` and `readFileBytes`; deliberately NOT `readFileBytesRange`, which tracks separately in `readRangeCalls`), in order -- lets a test assert exactly which/how many COMPLETE artifacts were read (e.g. "at most one chunk shard was ever loaded per query", "exactly N overlay containers were read in full"), not just the end result. */
  readFileCalls: string[] = [];
  /** Every `readFileBytesRange` call's [path, offset, length] -- lets a test assert an overlay's lazy prefix read never asked for more than header+metadata+noteVector bytes. */
  readRangeCalls: { path: string; offset: number; length: number }[] = [];

  async readFile(path: string): Promise<string> {
    this.readFileCalls.push(path);
    if (this.corruptNextReadOf.has(path)) {
      this.corruptNextReadOf.delete(path);
      return "{not-valid-json-after-all";
    }
    this.maybeFail("readFile", path);
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`ENOENT: ${path}`);
    return value;
  }

  async writeFile(path: string, contents: string): Promise<void> {
    this.maybeFail("writeFile", path);
    this.files.set(path, contents);
  }

  async readFileBytes(path: string): Promise<Uint8Array> {
    this.readFileCalls.push(path);
    await this.maybePause("readFileBytes", path);
    this.maybeFail("readFileBytes", path);
    const value = this.binaryFiles.get(path);
    if (value === undefined) throw new Error(`ENOENT: ${path}`);
    if (this.corruptNextReadBytesOf.has(path)) {
      this.corruptNextReadBytesOf.delete(path);
      return corrupted(value);
    }
    return value.slice();
  }

  async writeFileBytes(path: string, bytes: Uint8Array): Promise<void> {
    this.maybeFail("writeFileBytes", path);
    this.binaryFiles.set(path, bytes.slice());
  }

  async readFileBytesRange(path: string, offset: number, length: number): Promise<Uint8Array> {
    // Deliberately NOT pushed into `readFileCalls` (that array tracks FULL reads only, via
    // `readFile`/`readFileBytes`) -- a range read is exactly the lazy, partial I/O this method
    // exists to make possible, and tests assert on it separately via `readRangeCalls`.
    this.readRangeCalls.push({ path, offset, length });
    await this.maybePause("readFileBytesRange", path);
    this.maybeFail("readFileBytesRange", path);
    const value = this.binaryFiles.get(path);
    if (value === undefined) throw new Error(`ENOENT: ${path}`);
    if (offset + length > value.length) {
      throw new Error(`range read past end of file: ${path} (${offset}+${length} > ${value.length})`);
    }
    const slice = value.slice(offset, offset + length);
    if (this.corruptNextReadBytesOf.has(path)) {
      this.corruptNextReadBytesOf.delete(path);
      return corrupted(slice);
    }
    return slice;
  }

  /** Directory-tree-aware: if `fromPath` is a known directory (or has any file under it, JSON or binary), every entry under `fromPath/` is moved to `toPath/` atomically (all-or-nothing, matching real `fs.rename`'s single-syscall semantics for a directory). Otherwise behaves as a single-file rename (tried against whichever map actually has it). */
  async rename(fromPath: string, toPath: string): Promise<void> {
    await this.maybePause("rename", fromPath);
    this.maybeFail("rename", fromPath);
    const fromPrefix = `${fromPath}/`;
    const movingJsonKeys = [...this.files.keys()].filter((key) => key.startsWith(fromPrefix));
    const movingBinaryKeys = [...this.binaryFiles.keys()].filter((key) => key.startsWith(fromPrefix));
    if (movingJsonKeys.length > 0 || movingBinaryKeys.length > 0 || this.dirs.has(fromPath)) {
      const toPrefix = `${toPath}/`;
      for (const key of movingJsonKeys) {
        const contents = this.files.get(key);
        if (contents === undefined) continue;
        this.files.set(toPrefix + key.slice(fromPrefix.length), contents);
        this.files.delete(key);
      }
      for (const key of movingBinaryKeys) {
        const contents = this.binaryFiles.get(key);
        if (contents === undefined) continue;
        this.binaryFiles.set(toPrefix + key.slice(fromPrefix.length), contents);
        this.binaryFiles.delete(key);
      }
      const movingDirs = [...this.dirs].filter((dir) => dir === fromPath || dir.startsWith(fromPrefix));
      for (const dir of movingDirs) {
        this.dirs.delete(dir);
        this.dirs.add(dir === fromPath ? toPath : toPrefix + dir.slice(fromPrefix.length));
      }
      return;
    }
    if (this.files.has(fromPath)) {
      const value = this.files.get(fromPath) as string;
      this.files.set(toPath, value);
      this.files.delete(fromPath);
      return;
    }
    if (this.binaryFiles.has(fromPath)) {
      const value = this.binaryFiles.get(fromPath) as Uint8Array;
      this.binaryFiles.set(toPath, value);
      this.binaryFiles.delete(fromPath);
      return;
    }
    throw new Error(`ENOENT rename source: ${fromPath}`);
  }

  async unlink(path: string): Promise<void> {
    this.maybeFail("unlink", path);
    // Real fs.promises.unlink() rejects on a directory (EISDIR/EPERM depending on platform) --
    // it never silently no-ops or recursively deletes. Checked BEFORE the file maps so a path
    // that is both a tracked directory and (erroneously) a file map key still fails closed the
    // same way a real filesystem would.
    if (this.dirs.has(path)) {
      throw new Error(`EISDIR: illegal operation on a directory, unlink '${path}'`);
    }
    if (this.files.has(path)) {
      this.files.delete(path);
      return;
    }
    if (this.binaryFiles.has(path)) {
      this.binaryFiles.delete(path);
      return;
    }
    throw new Error(`ENOENT unlink: ${path}`);
  }

  /** Real `fs.promises.rmdir()` semantics: rejects if `path` is not a tracked directory, and rejects (ENOTEMPTY) if it still has any child file/directory. */
  async rmdir(path: string): Promise<void> {
    this.maybeFail("rmdir", path);
    if (!this.dirs.has(path)) {
      throw new Error(`ENOENT rmdir: ${path}`);
    }
    const children = await this.readdir(path);
    if (children.length > 0) {
      throw new Error(`ENOTEMPTY: directory not empty, rmdir '${path}'`);
    }
    this.dirs.delete(path);
  }

  async statSize(path: string): Promise<number> {
    this.maybeFail("statSize", path);
    const binary = this.binaryFiles.get(path);
    if (binary !== undefined) return binary.length;
    const text = this.files.get(path);
    if (text !== undefined) return Buffer.byteLength(text, "utf8");
    throw new Error(`ENOENT stat: ${path}`);
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.binaryFiles.has(path) || this.dirs.has(path);
  }

  async readdir(dirPath: string): Promise<string[]> {
    this.maybeFail("readdir", dirPath);
    const prefix = `${dirPath.replace(/\/+$/, "")}/`;
    const names = new Set<string>();
    for (const key of [...this.files.keys(), ...this.binaryFiles.keys()]) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      names.add(rest.includes("/") ? rest.slice(0, rest.indexOf("/")) : rest);
    }
    for (const dir of this.dirs) {
      if (!dir.startsWith(prefix)) continue;
      const rest = dir.slice(prefix.length);
      if (rest === "") continue;
      names.add(rest.includes("/") ? rest.slice(0, rest.indexOf("/")) : rest);
    }
    return [...names];
  }

  async mkdir(dirPath: string): Promise<void> {
    this.maybeFail("mkdir", dirPath);
    this.dirs.add(dirPath);
  }

  async fsync(path: string): Promise<void> {
    this.maybeFail("fsync", path);
    this.fsyncedPaths.add(path);
  }

  async fsyncDir(path: string): Promise<void> {
    this.maybeFail("fsyncDir", path);
    this.fsyncedDirs.add(path);
  }
}

function corrupted(bytes: Uint8Array): Uint8Array {
  const copy = bytes.slice();
  if (copy.length > 0) {
    copy[0] ^= 0xff;
  }
  return copy;
}
