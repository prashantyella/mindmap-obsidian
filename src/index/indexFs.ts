import type { AtomicStoreFs } from "../engine/atomicStore";
import { joinRelative, validateOwnedRelativePath } from "../engine/atomicStore";

/**
 * The small filesystem seam Checkpoint 5's persistence layer is injected
 * over. `AtomicStoreFs` (the exact same seam `AtomicStore` already uses
 * for every JSON artifact: manifest, note/shard metadata, the
 * current-generation pointer) plus: `mkdir`, since a generation/staging
 * directory must exist before any file inside it can be written; and raw
 * BYTE I/O (`readFileBytes`/`writeFileBytes`/`readFileBytesRange`) for
 * vector-matrix (`.mvx`) and overlay-container files, which are physical
 * binary formats on disk, never base64-in-JSON. `readFileBytesRange` is
 * what makes an overlay's header+metadata+note-vector prefix readable
 * without ever touching its (possibly large) chunk-vector bytes on disk --
 * the actual I/O-level laziness the merged committed view depends on, not
 * just "don't decode it once you have the bytes".
 */
export interface IndexFs extends AtomicStoreFs {
  /** Idempotent: must succeed (as a no-op) if the directory already exists, and must create any missing parent segments -- callers never need to check existence first. */
  mkdir(dirPath: string): Promise<void>;
  /** Removes an EMPTY directory only -- mirrors real `fs.promises.rmdir`'s non-recursive semantics: must reject if `dirPath` still has any children, and must reject if `dirPath` is not a directory at all. Every recursive removal in this layer (`generationStore.ts`'s `cleanupStaleStaging`) calls this bottom-up, one already-emptied directory at a time -- never given `{ recursive: true }` semantics, and never used as a substitute for `unlink` on a file. */
  rmdir(dirPath: string): Promise<void>;
  /** Reads a file's complete raw bytes. Unbounded at this layer (mirrors `AtomicStoreFs.readFile`) -- callers apply their own bounded-size check after the read, the same pattern `AtomicStore`'s `readBounded` already uses for JSON. */
  readFileBytes(path: string): Promise<Uint8Array>;
  writeFileBytes(path: string, bytes: Uint8Array): Promise<void>;
  /** Reads exactly `length` bytes starting at byte `offset` -- a bounded partial read, never the whole file. Used to read a container's fixed-size-prefix-derived header+metadata+note-vector span without ever reading (or paying the I/O cost of) whatever chunk-vector bytes follow it. Must throw if the file is shorter than `offset + length`. */
  readFileBytesRange(path: string, offset: number, length: number): Promise<Uint8Array>;
  /** Returns the exact byte length of the file at `path` WITHOUT reading (or allocating for) its contents -- lets a caller reject an oversized file before ever calling `readFileBytes` on it. Must throw if `path` does not exist. */
  statSize(path: string): Promise<number>;
}

export class IndexFsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IndexFsError";
  }
}

/**
 * One root directory this whole persistence layer owns exclusively.
 * Every relative path any Checkpoint 5 module computes is validated
 * against this root (no `..` traversal, no absolute/drive-letter/UNC
 * form, no control/NUL byte -- the exact same rule `AtomicStore` already
 * enforces per file, reused here via `validateOwnedRelativePath` so the
 * two can never drift on what "inside the owned root" means) before any
 * filesystem call is made from it. Nothing in this layer ever deletes a
 * directory recursively or by wildcard; every removal targets one
 * specific, individually-validated path.
 */
export class OwnedRoot {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  /** Validates `relativePath` resolves inside this root and returns its absolute-within-root path. Throws `IndexFsError` (not `EngineError`) so every Checkpoint 5 module has one consistent failure type for path/layout problems, independent of `AtomicStore`'s own (file-scoped) error type. */
  resolve(relativePath: string, context: string): string {
    try {
      validateOwnedRelativePath(relativePath, this.root, context);
    } catch (error) {
      throw new IndexFsError(error instanceof Error ? error.message : String(error));
    }
    return joinRelative(this.root, relativePath);
  }

  child(relativePath: string, context: string): OwnedRoot {
    return new OwnedRoot(this.resolve(relativePath, context));
  }
}
