import { EngineError } from "./errors";

/**
 * The filesystem seam `AtomicStore<T>` is injected over. Deliberately a
 * small subset of `node:fs/promises` (never the module itself) so tests can
 * substitute an in-memory fake and fault-inject at any single call. `rename`
 * is required to be atomic on the same filesystem (true of `fs.rename` on
 * every OS Obsidian ships on for a temp file placed beside its destination).
 */
export interface AtomicStoreFs {
  readFile(path: string): Promise<string>;
  writeFile(path: string, contents: string): Promise<void>;
  rename(fromPath: string, toPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** Returns basenames of `dirPath`'s immediate children only (never a recursive/full-relative-path listing) -- the same contract as `fs.promises.readdir`. */
  readdir(dirPath: string): Promise<string[]>;
  /** Best-effort durability sync for the just-written temp file. Absent (or a no-op) on filesystems/adapters that don't support it -- never required for correctness, only for surviving a hard power loss. */
  fsync?(path: string): Promise<void>;
  /** Best-effort durability sync of the directory entry after a rename (needed on some filesystems for the rename itself to survive a hard power loss). Optional and best-effort: by the time this would run, `rename` has already succeeded, so a failure here is swallowed rather than surfaced -- the commit is already visible and, on filesystems where directory fsync isn't needed for durability, already durable. */
  fsyncDir?(path: string): Promise<void>;
}

export interface AtomicStoreOptions<T> {
  fs: AtomicStoreFs;
  /** Directory this store is allowed to touch. Every path this store computes (state file, temp files) must resolve inside it; anything else is rejected before any filesystem call. */
  root: string;
  /** Vault/data-relative path of the committed state file, relative to `root`. May include subdirectory segments (e.g. `"jobs/queue.json"`); temp files are always placed beside the committed file, in the same subdirectory, never in `root` itself when `fileName` is nested. */
  fileName: string;
  /** The schema version this store instance writes and requires on load. A persisted document with a different version fails closed rather than being reinterpreted. */
  schemaVersion: number;
  /** Strict shape validation for a freshly-parsed JSON document; throws (any error) to reject it. Called on every load, including immediately after a write-back verification read. */
  parse: (value: unknown) => T;
  /** Maximum bytes this store will accept from `fileName` or a temp file. The seam has no size-probe primitive, so this is enforced after `fs.readFile` returns rather than before -- it rejects an oversized document from being parsed or persisted, but does not bound the memory used by the read itself. */
  maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
/** Exported so a sibling atomic primitive for a different payload shape (e.g. `AtomicBinaryStore`, for raw bytes rather than JSON) can use the exact same temp-file naming convention -- `cleanupStaleTempFiles`-style sweeps and fault-injection tests then never need to know which primitive produced a given leftover temp file. */
export const TEMP_PREFIX = ".atomic-tmp-";

export function joinRelative(root: string, relativePath: string): string {
  const normalizedRoot = root.replace(/\/+$/, "");
  const normalizedRelative = relativePath.replace(/^\/+/, "");
  return `${normalizedRoot}/${normalizedRelative}`;
}

/** Splits a validated, already-normalized (`/`-separated) relative path into its directory portion (`""` when there is none) and final basename. */
export function splitDirAndBase(relativePath: string): { dir: string; base: string } {
  const normalized = relativePath.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  if (index === -1) return { dir: "", base: normalized };
  return { dir: normalized.slice(0, index), base: normalized.slice(index + 1) };
}

/** Rejects any relative path that would resolve outside `root` -- no `..` segment, no absolute/drive-letter/UNC form, no NUL/control byte. */
export function validateOwnedRelativePath(relativePath: string, root: string, context: string): void {
  if (relativePath.trim() === "") {
    throw new EngineError("STORE_PATH_INVALID", `${context} path must not be empty.`, { root });
  }
  // eslint-disable-next-line no-control-regex -- intentionally matches control/NUL bytes
  if (/[\u0000-\u001F\u007F]/.test(relativePath)) {
    throw new EngineError("STORE_PATH_INVALID", `${context} path contains a control or NUL character.`, { root, relativePath });
  }
  const normalized = relativePath.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//")) {
    throw new EngineError("STORE_PATH_INVALID", `${context} path must be relative to the owned root.`, { root, relativePath });
  }
  const segments = normalized.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.includes("..")) {
    throw new EngineError("STORE_PATH_INVALID", `${context} path must not traverse outside the owned root.`, { root, relativePath });
  }
  if (segments.length === 0) {
    throw new EngineError("STORE_PATH_INVALID", `${context} path is empty after normalization.`, { root, relativePath });
  }
}

interface PersistedEnvelope {
  schemaVersion: number;
  data: unknown;
}

function readBounded(contents: string, maxBytes: number, context: string): string {
  const byteLength = Buffer.byteLength(contents, "utf8");
  if (byteLength > maxBytes) {
    throw new EngineError("STORE_READ_FAILED", `${context} exceeds the maximum bounded read size (${byteLength} > ${maxBytes} bytes).`, {
      byteLength,
      maxBytes,
    });
  }
  return contents;
}

function parseEnvelope<T>(contents: string, expectedSchemaVersion: number, parse: (value: unknown) => T, context: string): T {
  let outer: unknown;
  try {
    outer = JSON.parse(contents);
  } catch (error) {
    throw new EngineError("STORE_SCHEMA_INVALID", `${context} is not valid JSON.`, { cause: String(error) });
  }
  if (typeof outer !== "object" || outer === null || Array.isArray(outer)) {
    throw new EngineError("STORE_SCHEMA_INVALID", `${context} must be a JSON object envelope.`, {});
  }
  const envelope = outer as Partial<PersistedEnvelope>;
  if (envelope.schemaVersion !== expectedSchemaVersion) {
    throw new EngineError(
      "STORE_SCHEMA_INVALID",
      `${context} has schemaVersion ${String(envelope.schemaVersion)}; expected ${expectedSchemaVersion}.`,
      { received: envelope.schemaVersion, expected: expectedSchemaVersion },
    );
  }
  try {
    return parse(envelope.data);
  } catch (error) {
    throw new EngineError("STORE_SCHEMA_INVALID", `${context} failed strict shape validation.`, { cause: String(error) });
  }
}

/**
 * Generic versioned atomic store: `load()` reads and strictly validates the
 * committed state file (failing closed -- never returning a partially valid
 * or reinterpreted document -- on any schema/shape/size problem); `save()`
 * writes through a validated temp file placed beside the committed path,
 * flushes it where the injected `fs` supports `fsync`, reads it back and
 * re-validates it against the exact same bounded-size/schema/shape rules
 * `load()` uses, and only then atomically renames it onto the committed
 * path. A crash or fault at any point before the rename -- including a
 * corrupt/short/truncated write-back read -- leaves the previously
 * committed state completely untouched; only the temp file is removed.
 *
 * Never deletes anything outside its own temp-file naming convention
 * (`${baseName}${TEMP_PREFIX}...`) inside the committed file's own parent
 * directory -- `cleanupStaleTempFiles` only ever removes files matching
 * that exact prefix, and only counts an entry as removed once `unlink`
 * actually succeeds for it.
 */
export class AtomicStore<T> {
  private readonly fs: AtomicStoreFs;
  private readonly root: string;
  private readonly fileName: string;
  private readonly schemaVersion: number;
  private readonly parseValue: (value: unknown) => T;
  private readonly maxBytes: number;
  private readonly filePath: string;
  /** Directory portion of `fileName` relative to `root` (`""` when `fileName` has no subdirectory). */
  private readonly fileDir: string;
  private readonly fileBaseName: string;
  /** Absolute-within-root path of the committed file's parent directory -- `root` itself when `fileName` has no subdirectory. */
  private readonly parentDirPath: string;

  constructor(options: AtomicStoreOptions<T>) {
    validateOwnedRelativePath(options.fileName, options.root, "AtomicStore fileName");
    this.fs = options.fs;
    this.root = options.root;
    this.fileName = options.fileName;
    this.schemaVersion = options.schemaVersion;
    this.parseValue = options.parse;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.filePath = joinRelative(this.root, this.fileName);
    const { dir, base } = splitDirAndBase(this.fileName);
    this.fileDir = dir;
    this.fileBaseName = base;
    this.parentDirPath = dir === "" ? this.root : joinRelative(this.root, dir);
  }

  /** `null` when no committed state file exists yet (a fresh store); throws `EngineError` for anything else that prevents returning a valid `T`. */
  async load(): Promise<T | null> {
    if (!(await this.fs.exists(this.filePath))) {
      return null;
    }
    let raw: string;
    try {
      raw = await this.fs.readFile(this.filePath);
    } catch (error) {
      throw new EngineError("STORE_READ_FAILED", `Failed to read committed state file "${this.fileName}".`, { cause: String(error) });
    }
    const bounded = readBounded(raw, this.maxBytes, `Committed state file "${this.fileName}"`);
    return parseEnvelope(bounded, this.schemaVersion, this.parseValue, `Committed state file "${this.fileName}"`);
  }

  async save(value: T): Promise<void> {
    // Re-validate before ever touching the filesystem: a caller-constructed value that would fail its own parser must never be persisted.
    let verified: T;
    try {
      verified = this.parseValue(JSON.parse(JSON.stringify(value)) as unknown);
    } catch (error) {
      throw new EngineError("STORE_SCHEMA_INVALID", `Refusing to save a value that fails its own schema validation.`, { cause: String(error) });
    }
    const envelope: PersistedEnvelope = { schemaVersion: this.schemaVersion, data: verified };
    const serialized = readBounded(JSON.stringify(envelope, null, 2), this.maxBytes, `Serialized state for "${this.fileName}"`);

    const tempBaseName = `${this.fileBaseName}${TEMP_PREFIX}${randomToken()}`;
    const tempRelative = this.fileDir === "" ? tempBaseName : `${this.fileDir}/${tempBaseName}`;
    validateOwnedRelativePath(tempRelative, this.root, "AtomicStore temp file");
    const tempPath = joinRelative(this.root, tempRelative);

    try {
      await this.fs.writeFile(tempPath, serialized);
      if (this.fs.fsync) {
        await this.fs.fsync(tempPath);
      }
    } catch (error) {
      await this.safeUnlink(tempPath);
      throw new EngineError("STORE_WRITE_FAILED", `Failed to write temp file for "${this.fileName}".`, { cause: String(error) });
    }

    // Write-back verification: read the temp file back and require it to pass the exact same
    // bounded-size/JSON/schema/shape validation load() enforces, BEFORE the rename. A truncated
    // write, a corrupt write, or a read failure on the just-written temp file must never reach
    // the committed path -- only the temp file is removed, and the previously committed state
    // (if any) is left completely untouched because rename() is never called.
    try {
      const readBack = await this.fs.readFile(tempPath);
      const bounded = readBounded(readBack, this.maxBytes, `Temp file for "${this.fileName}"`);
      parseEnvelope(bounded, this.schemaVersion, this.parseValue, `Temp file for "${this.fileName}"`);
    } catch (error) {
      await this.safeUnlink(tempPath);
      throw new EngineError(
        "STORE_WRITE_FAILED",
        `Write-back verification failed for "${this.fileName}"; committed state left unchanged.`,
        { cause: String(error) },
      );
    }

    try {
      await this.fs.rename(tempPath, this.filePath);
    } catch (error) {
      await this.safeUnlink(tempPath);
      throw new EngineError("STORE_WRITE_FAILED", `Failed to atomically commit "${this.fileName}".`, { cause: String(error) });
    }

    if (this.fs.fsyncDir) {
      try {
        await this.fs.fsyncDir(this.parentDirPath);
      } catch {
        // The rename already succeeded and is visible; a directory-fsync failure here is
        // best-effort durability only (surviving a hard power loss immediately after the
        // rename) and must never turn an already-committed save() into a thrown error.
      }
    }
  }

  /** Removes leftover `${baseName}${TEMP_PREFIX}*` files from a prior interrupted `save()`, scanning the committed file's own parent directory (not always `root` -- correct for a nested `fileName`). Matches only this store's own exact temp-file naming convention -- never a broad directory sweep -- and only counts an entry once its `unlink` actually succeeds. */
  async cleanupStaleTempFiles(): Promise<number> {
    let entries: string[];
    try {
      entries = await this.fs.readdir(this.parentDirPath);
    } catch {
      return 0;
    }
    const prefix = `${this.fileBaseName}${TEMP_PREFIX}`;
    let removed = 0;
    for (const entry of entries) {
      if (!entry.startsWith(prefix)) continue;
      const candidateRelative = this.fileDir === "" ? entry : `${this.fileDir}/${entry}`;
      try {
        validateOwnedRelativePath(candidateRelative, this.root, "AtomicStore cleanup");
      } catch {
        continue;
      }
      try {
        await this.fs.unlink(joinRelative(this.root, candidateRelative));
        removed += 1;
      } catch {
        // Leave it for a later cleanup pass; a failed unlink must not be counted as removed.
      }
    }
    return removed;
  }

  /** Read-only counterpart to `cleanupStaleTempFiles`: counts leftover `${baseName}${TEMP_PREFIX}*` entries via the same matching rule, without ever calling `unlink`. Used by preflight, which must never mutate (Checkpoint 9 requirement 2). */
  async countStaleTempFiles(): Promise<number> {
    let entries: string[];
    try {
      entries = await this.fs.readdir(this.parentDirPath);
    } catch {
      return 0;
    }
    const prefix = `${this.fileBaseName}${TEMP_PREFIX}`;
    let count = 0;
    for (const entry of entries) {
      if (!entry.startsWith(prefix)) continue;
      const candidateRelative = this.fileDir === "" ? entry : `${this.fileDir}/${entry}`;
      try {
        validateOwnedRelativePath(candidateRelative, this.root, "AtomicStore stale-temp count");
      } catch {
        continue;
      }
      count += 1;
    }
    return count;
  }

  private async safeUnlink(path: string): Promise<void> {
    try {
      await this.fs.unlink(path);
    } catch {
      // Best-effort cleanup only; a failed unlink here must never mask the original error or block the caller.
    }
  }
}

function randomToken(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
