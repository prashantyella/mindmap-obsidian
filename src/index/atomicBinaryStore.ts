import { joinRelative, splitDirAndBase, TEMP_PREFIX, validateOwnedRelativePath } from "../engine/atomicStore";
import type { IndexFs } from "./indexFs";

/**
 * `AtomicStore`'s exact write/verify/commit discipline (temp file beside
 * the destination, fsync, byte-for-byte write-back readback, atomic
 * rename, best-effort directory fsync), applied to RAW BYTES instead of a
 * JSON envelope -- the atomic write primitive vector-matrix (`.mvx`) and
 * overlay-container files use, since those are physical binary formats on
 * disk, never JSON. Reuses `AtomicStore`'s own path-safety and temp-file
 * naming helpers (`validateOwnedRelativePath`, `joinRelative`,
 * `splitDirAndBase`, `TEMP_PREFIX`) rather than re-deriving them, so a
 * `.mvx` write and a JSON write can never disagree about what "inside the
 * owned root" or "a leftover temp file" means.
 */

export class AtomicBinaryStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AtomicBinaryStoreError";
  }
}

export interface AtomicBinaryStoreOptions {
  fs: IndexFs;
  root: string;
  /** Vault/data-relative path of the committed binary file, relative to `root`. */
  fileName: string;
  /** Maximum bytes this store will ever read back or accept for write; guards against an unbounded/corrupt file wedging the plugin. */
  maxBytes: number;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

export class AtomicBinaryStore {
  private readonly fs: IndexFs;
  private readonly root: string;
  private readonly fileName: string;
  private readonly maxBytes: number;
  private readonly filePath: string;
  private readonly fileDir: string;
  private readonly fileBaseName: string;
  private readonly parentDirPath: string;

  constructor(options: AtomicBinaryStoreOptions) {
    validateOwnedRelativePath(options.fileName, options.root, "AtomicBinaryStore fileName");
    this.fs = options.fs;
    this.root = options.root;
    this.fileName = options.fileName;
    this.maxBytes = options.maxBytes;
    this.filePath = joinRelative(this.root, this.fileName);
    const { dir, base } = splitDirAndBase(this.fileName);
    this.fileDir = dir;
    this.fileBaseName = base;
    this.parentDirPath = dir === "" ? this.root : joinRelative(this.root, dir);
  }

  /** `null` when no committed file exists yet. Throws `AtomicBinaryStoreError` if the file exceeds `maxBytes` -- checked via `statSize`, BEFORE `readFileBytes` is ever called, so an oversized file is rejected before its full contents are read into memory at all (never just after). */
  async load(): Promise<Uint8Array | null> {
    if (!(await this.fs.exists(this.filePath))) {
      return null;
    }
    await this.assertBoundedSizeOrThrow(this.filePath, `Committed binary file "${this.fileName}"`);
    let bytes: Uint8Array;
    try {
      bytes = await this.fs.readFileBytes(this.filePath);
    } catch (error) {
      throw new AtomicBinaryStoreError(`Failed to read committed binary file "${this.fileName}": ${error instanceof Error ? error.message : String(error)}`);
    }
    if (bytes.length > this.maxBytes) {
      throw new AtomicBinaryStoreError(`Committed binary file "${this.fileName}" exceeds the maximum bounded read size (${bytes.length} > ${this.maxBytes} bytes).`);
    }
    return bytes;
  }

  /**
   * Rejects (via `statSize`, never a full `readFileBytes`) if the file at
   * `path` is missing, if `statSize` returns a value that isn't a valid
   * byte count (negative, fractional, non-finite, or beyond
   * `Number.MAX_SAFE_INTEGER` -- never trusted implicitly, since it could
   * come from a misbehaving/adversarial `IndexFs` implementation), or if it
   * exceeds `maxBytes`. Every one of these rejections happens before this
   * method returns, so no caller ever reaches `readFileBytes` on an invalid
   * stat result.
   */
  private async assertBoundedSizeOrThrow(path: string, context: string): Promise<void> {
    let size: number;
    try {
      size = await this.fs.statSize(path);
    } catch (error) {
      throw new AtomicBinaryStoreError(`Failed to stat ${context}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new AtomicBinaryStoreError(`${context} reported an invalid size from statSize (${size}); expected a non-negative safe integer.`);
    }
    if (size > this.maxBytes) {
      throw new AtomicBinaryStoreError(`${context} exceeds the maximum bounded read size (${size} > ${this.maxBytes} bytes).`);
    }
  }

  /**
   * Reads exactly `length` bytes at `offset` from the COMMITTED file,
   * without reading the rest of it. Validates `offset`/`length` as
   * non-negative integers and `offset + length` as a safe integer bounded
   * by `maxBytes` BEFORE ever calling into the filesystem -- an
   * adversarial/corrupted caller-supplied range (e.g. derived from a
   * corrupt on-disk length field) can never reach `IndexFs.readFileBytesRange`
   * at all. Throws if no committed file exists, if it is shorter than
   * `offset + length`, or if the filesystem returns a length other than
   * exactly `length` (a lying/misbehaving `IndexFs` implementation is
   * never trusted implicitly).
   */
  async loadRange(offset: number, length: number): Promise<Uint8Array> {
    if (!Number.isInteger(offset) || offset < 0) {
      throw new AtomicBinaryStoreError(`loadRange offset must be a non-negative integer; got ${offset}.`);
    }
    if (!Number.isInteger(length) || length < 0) {
      throw new AtomicBinaryStoreError(`loadRange length must be a non-negative integer; got ${length}.`);
    }
    const end = offset + length;
    if (!Number.isSafeInteger(end) || end > this.maxBytes) {
      throw new AtomicBinaryStoreError(`loadRange range [${offset}, ${end}) exceeds the ${this.maxBytes}-byte bound for "${this.fileName}".`);
    }
    if (!(await this.fs.exists(this.filePath))) {
      throw new AtomicBinaryStoreError(`Binary file "${this.fileName}" does not exist.`);
    }
    let bytes: Uint8Array;
    try {
      bytes = await this.fs.readFileBytesRange(this.filePath, offset, length);
    } catch (error) {
      throw new AtomicBinaryStoreError(`Failed to read a byte range of "${this.fileName}": ${error instanceof Error ? error.message : String(error)}`);
    }
    if (bytes.length !== length) {
      throw new AtomicBinaryStoreError(`loadRange of "${this.fileName}" returned ${bytes.length} bytes; expected exactly ${length}.`);
    }
    return bytes;
  }

  async save(bytes: Uint8Array): Promise<void> {
    if (bytes.length > this.maxBytes) {
      throw new AtomicBinaryStoreError(`Refusing to save ${bytes.length} bytes to "${this.fileName}", exceeding the ${this.maxBytes}-byte bound.`);
    }
    const tempBaseName = `${this.fileBaseName}${TEMP_PREFIX}${randomToken()}`;
    const tempRelative = this.fileDir === "" ? tempBaseName : `${this.fileDir}/${tempBaseName}`;
    validateOwnedRelativePath(tempRelative, this.root, "AtomicBinaryStore temp file");
    const tempPath = joinRelative(this.root, tempRelative);

    try {
      await this.fs.writeFileBytes(tempPath, bytes);
      if (this.fs.fsync) {
        await this.fs.fsync(tempPath);
      }
    } catch (error) {
      await this.safeUnlink(tempPath);
      throw new AtomicBinaryStoreError(`Failed to write temp file for "${this.fileName}": ${error instanceof Error ? error.message : String(error)}`);
    }

    // Write-back verification: read the temp file back byte-for-byte BEFORE the rename. A
    // truncated or corrupt write, or a read failure, must never reach the committed path -- only
    // the temp file is removed, and any previously committed file is left completely untouched.
    // The size is checked (via statSize, never a full read) BEFORE readFileBytes is ever called --
    // an unexpectedly oversized temp file (e.g. from a misbehaving filesystem) is rejected without
    // ever reading or allocating for its full contents.
    try {
      await this.assertBoundedSizeOrThrow(tempPath, `Temp file for "${this.fileName}"`);
      const readBack = await this.fs.readFileBytes(tempPath);
      if (!bytesEqual(readBack, bytes)) {
        throw new Error("write-back readback did not match the bytes just written");
      }
    } catch (error) {
      await this.safeUnlink(tempPath);
      throw new AtomicBinaryStoreError(`Write-back verification failed for "${this.fileName}"; committed state left unchanged: ${error instanceof Error ? error.message : String(error)}`);
    }

    try {
      await this.fs.rename(tempPath, this.filePath);
    } catch (error) {
      await this.safeUnlink(tempPath);
      throw new AtomicBinaryStoreError(`Failed to atomically commit "${this.fileName}": ${error instanceof Error ? error.message : String(error)}`);
    }

    if (this.fs.fsyncDir) {
      try {
        await this.fs.fsyncDir(this.parentDirPath);
      } catch {
        // Best-effort durability only, same as AtomicStore -- the rename already succeeded.
      }
    }
  }

  private async safeUnlink(path: string): Promise<void> {
    try {
      await this.fs.unlink(path);
    } catch {
      // Best-effort cleanup only; must never mask the original error.
    }
  }
}

function randomToken(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
