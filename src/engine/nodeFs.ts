import fs from "node:fs";
import path from "node:path";

import { EngineError } from "./errors";
import type { IndexFs } from "../index/indexFs";

/**
 * Real, Node-backed `IndexFs` (which is a superset of `AtomicStoreFs`)
 * targeting exactly one plugin-owned data directory on disk. This is the
 * one place `AtomicStore`/`IndexStore`/`JobStore`/`ScheduleStore` meet a
 * real filesystem in the shipped plugin -- every other engine module stays
 * injected/Node-testable against a fake.
 *
 * Every path this adapter is asked to touch must already be an
 * absolute-within-root path (exactly what `AtomicStore`/`IndexStore`
 * compute via `joinRelative(root, ...)` before calling into this seam --
 * see `atomicStore.ts`'s doc comments). This adapter re-validates
 * containment itself rather than trusting the caller: it is the last line
 * of defense against a path that would otherwise escape the owned root,
 * including via a symlink planted at (or under) an existing path.
 *
 * TOCTOU note: a userspace path-string check (even one that resolves every
 * symlink via `realpath`) can never be fully race-free against a symlink
 * planted or swapped between the check and the actual syscall -- only a
 * kernel-enforced, descriptor-based check can close that specific window.
 * This adapter closes what it can: every read/write of an EXISTING leaf
 * goes through `openContained`, which opens with `O_NOFOLLOW` so the open
 * itself fails if the leaf is (or has become) a symlink, rather than
 * silently following it outside the owned root. `mkdir`/`rmdir`/`rename`/
 * `unlink` are not vulnerable to this same leaf-level race by POSIX syscall
 * semantics themselves (none of them follow a trailing symlink at the path
 * they are given), so only the PARENT-chain validation
 * (`assertDestinationContained`) applies to them.
 */
export class NodeFsContainmentError extends EngineError {
  constructor(message: string, context?: Record<string, unknown>) {
    super("STORE_PATH_INVALID", message, context);
  }
}

const MAX_BOUNDED_READ_BYTES = 64 * 1024 * 1024;
/** `0` on a platform where Node does not define `O_NOFOLLOW` (Windows) -- ORing with `0` is a safe no-op there, so `openContained` degrades to a plain open on that platform rather than throwing/crashing; the leaf-level defense described in this module's doc comment is then simply unavailable, not broken. */
const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

export class NodeOwnedFs implements IndexFs {
  private readonly root: string;
  /**
   * Pinned once a successful `realpath` of the owned root has been
   * observed -- every subsequent containment check reuses this cached
   * value instead of re-resolving the root's own realpath on every single
   * operation, narrowing (never fully eliminating -- see this module's
   * doc comment) the window a root-level symlink swap could exploit
   * across this instance's lifetime. Only ENOENT/ENOTDIR (root does not
   * exist yet) skips pinning -- a later call can still pin successfully
   * once the root actually exists; any other error is a real failure.
   */
  private pinnedRootRealPath: string | null = null;

  constructor(root: string) {
    if (!path.isAbsolute(root)) {
      throw new NodeFsContainmentError("NodeOwnedFs root must be an absolute path.");
    }
    this.root = path.resolve(root);
  }

  /**
   * Resolves `targetPath` to its normalized absolute form and requires it
   * to be `this.root` itself or a descendant of it -- no `..` escape, no
   * absolute path outside the root, regardless of how `targetPath` was
   * spelled. Never throws for a merely nonexistent path (that is a normal,
   * expected case for the first write of a new file); it only rejects
   * paths that resolve outside the owned root.
   */
  private assertContained(targetPath: string, context: string): string {
    const resolved = path.resolve(targetPath);
    const withSep = this.root.endsWith(path.sep) ? this.root : `${this.root}${path.sep}`;
    if (resolved !== this.root && !resolved.startsWith(withSep)) {
      throw new NodeFsContainmentError(`${context} resolves outside the owned root.`);
    }
    return resolved;
  }

  /** Every thrown value this class ever surfaces is redacted through here first: a raw Node `fs` error's `.message` (and `.path`) embeds the real, absolute, possibly-sensitive filesystem path -- this strips that down to a closed error class carrying only the syscall's `code` (e.g. `"ENOENT"`, `"EACCES"`), never a path or free-text message from the OS. */
  private redact(error: unknown, context: string): NodeFsContainmentError {
    if (error instanceof NodeFsContainmentError) return error;
    const code = (error as NodeJS.ErrnoException)?.code;
    return new NodeFsContainmentError(`${context} failed.`, code ? { code } : {});
  }

  private errnoCode(error: unknown): string | undefined {
    return (error as NodeJS.ErrnoException)?.code;
  }

  /** Resolves and PINS the owned root's own real (symlink-resolved) path -- see the field doc comment. */
  private async getRootRealPath(): Promise<string> {
    if (this.pinnedRootRealPath) return this.pinnedRootRealPath;
    try {
      const real = await fs.promises.realpath(this.root);
      this.pinnedRootRealPath = real;
      return real;
    } catch (error) {
      const code = this.errnoCode(error);
      if (code === "ENOENT" || code === "ENOTDIR") return this.root;
      throw this.redact(error, "resolving the owned root");
    }
  }

  /**
   * Extra defense against a symlink planted at (or under) an already-
   * existing path pointing outside the owned root: if `resolved` exists,
   * its REAL (symlink-resolved) path must also stay contained. A
   * nonexistent path (the common case for a fresh write) is not an error
   * here -- there is nothing to resolve yet, and the plain containment
   * check above already covers the path as spelled. Any OTHER error
   * (permission denied, I/O error, etc.) is a real failure and propagates
   * (redacted), never silently swallowed as "doesn't exist".
   */
  private async assertRealPathContained(resolved: string, context: string): Promise<void> {
    let real: string;
    try {
      real = await fs.promises.realpath(resolved);
    } catch (error) {
      const code = this.errnoCode(error);
      if (code === "ENOENT" || code === "ENOTDIR") return;
      throw this.redact(error, context);
    }
    await this.assertRealWithinRoot(real, [], context);
  }

  /**
   * Validates `real` (the real, symlink-resolved path of some existing
   * ancestor) plus a literal `suffix` of not-yet-existing path segments
   * appended after it, against the PINNED root real path -- shared by
   * `assertRealPathContained` (suffix always empty, `real` is the target
   * itself) and `assertDestinationContained` (suffix is whatever portion of
   * the target does not exist yet).
   */
  private async assertRealWithinRoot(real: string, suffix: readonly string[], context: string): Promise<void> {
    const realRoot = await this.getRootRealPath();
    const withSep = realRoot.endsWith(path.sep) ? realRoot : `${realRoot}${path.sep}`;
    const isContained = (candidate: string) => candidate === realRoot || candidate.startsWith(withSep);
    if (!isContained(real)) {
      throw new NodeFsContainmentError(`${context} resolves (via symlink) outside the owned root.`);
    }
    const full = suffix.length > 0 ? path.join(real, ...suffix) : real;
    if (!isContained(full)) {
      throw new NodeFsContainmentError(`${context} resolves (via symlink) outside the owned root.`);
    }
  }

  /**
   * Validates a WRITE/MKDIR/RENAME-DESTINATION path that may not exist yet
   * (`assertRealPathContained` alone is a no-op for a nonexistent path,
   * which is exactly the gap a symlinked PARENT directory can exploit:
   * `root/link -> /outside` then a write to `root/link/new-file` resolves
   * `root/link/new-file` itself to ENOENT and skips validation entirely).
   * Walks up from `resolved` until it finds the nearest existing ancestor,
   * resolves THAT ancestor's real path, and validates it (plus the literal,
   * not-yet-existing suffix appended after it) against the owned root. If
   * no ancestor exists at all (rare -- would mean even a filesystem root is
   * missing), there is nothing to validate against and the plain
   * `assertContained` spelling check already performed is relied on alone.
   */
  private async assertDestinationContained(resolved: string, context: string): Promise<void> {
    let current = resolved;
    const suffix: string[] = [];
    for (;;) {
      let real: string;
      try {
        real = await fs.promises.realpath(current);
      } catch (error) {
        const code = this.errnoCode(error);
        if (code !== "ENOENT" && code !== "ENOTDIR") throw this.redact(error, context);
        const parent = path.dirname(current);
        if (parent === current) return;
        suffix.unshift(path.basename(current));
        current = parent;
        continue;
      }
      const rootFromAncestor = path.relative(current, this.root);
      if (rootFromAncestor === "" || (!rootFromAncestor.startsWith(`..${path.sep}`) && rootFromAncestor !== ".." && !path.isAbsolute(rootFromAncestor))) {
        const prospectiveRoot = path.join(real, rootFromAncestor);
        const full = suffix.length > 0 ? path.join(real, ...suffix) : real;
        const withSep = prospectiveRoot.endsWith(path.sep) ? prospectiveRoot : `${prospectiveRoot}${path.sep}`;
        if (full !== prospectiveRoot && !full.startsWith(withSep)) {
          throw new NodeFsContainmentError(`${context} resolves (via symlink) outside the owned root.`);
        }
        this.pinnedRootRealPath ??= prospectiveRoot;
        return;
      }
      await this.assertRealWithinRoot(real, suffix, context);
      return;
    }
  }

  /**
   * Opens `resolved` with `O_NOFOLLOW` on its FINAL path component -- see
   * this module's doc comment. `ELOOP` (the leaf is/became a symlink) is
   * converted to a closed containment error; any other open failure is
   * redacted like every other thrown value in this class.
   */
  private async openContained(resolved: string, flags: number, context: string): Promise<fs.promises.FileHandle> {
    try {
      return await fs.promises.open(resolved, flags | O_NOFOLLOW);
    } catch (error) {
      if (this.errnoCode(error) === "ELOOP") {
        throw new NodeFsContainmentError(`${context} target is a symlink, which is not permitted here.`);
      }
      throw this.redact(error, context);
    }
  }

  /** Pre-stats an already-open handle and rejects before a full-file read allocates for an unexpectedly huge file. Used only by WHOLE-FILE reads -- a bounded RANGE read validates the size differently (see `assertValidSize`), since a legitimate approved index artifact (a `.mvx` shard) can be hundreds of MiB while any one bounded range read out of it stays small. */
  private assertBoundedStatSize(size: number, context: string): void {
    this.assertValidSize(size, context);
    if (size > MAX_BOUNDED_READ_BYTES) {
      throw new NodeFsContainmentError(`${context} target exceeds the bounded read size (${size} > ${MAX_BOUNDED_READ_BYTES} bytes).`);
    }
  }

  /** Validates a reported file size is a plain non-negative safe integer -- WITHOUT capping it to `MAX_BOUNDED_READ_BYTES`. A bounded range read only ever bounds the REQUESTED length (already checked before this runs), never the total file size -- rejecting a valid multi-hundred-MiB index artifact just because the file itself is large would be a regression (closure review item 5). */
  private assertValidSize(size: number, context: string): void {
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new NodeFsContainmentError(`${context} target reported an invalid size.`);
    }
  }

  /** Closes `handle`, redacting a close failure like every other thrown value in this class -- a bare `await handle.close()` in a `finally` block would otherwise let a raw (path-embedding) close error override whatever the `try`/`catch` above it already redacted. */
  private async closeHandle(handle: fs.promises.FileHandle, context: string): Promise<void> {
    try {
      await handle.close();
    } catch (error) {
      throw this.redact(error, context);
    }
  }

  async readFile(targetPath: string): Promise<string> {
    const resolved = this.assertContained(targetPath, "readFile");
    await this.assertRealPathContained(resolved, "readFile");
    const handle = await this.openContained(resolved, fs.constants.O_RDONLY, "readFile");
    try {
      const stat = await handle.stat();
      this.assertBoundedStatSize(stat.size, "readFile");
      return await handle.readFile("utf8");
    } catch (error) {
      throw this.redact(error, "readFile");
    } finally {
      await this.closeHandle(handle, "readFile");
    }
  }

  async writeFile(targetPath: string, contents: string): Promise<void> {
    const resolved = this.assertContained(targetPath, "writeFile");
    await this.assertDestinationContained(resolved, "writeFile");
    try {
      await fs.promises.mkdir(path.dirname(resolved), { recursive: true });
    } catch (error) {
      throw this.redact(error, "writeFile");
    }
    const handle = await this.openContained(resolved, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC, "writeFile");
    try {
      await handle.writeFile(contents, "utf8");
    } catch (error) {
      throw this.redact(error, "writeFile");
    } finally {
      await this.closeHandle(handle, "writeFile");
    }
  }

  async rename(fromPath: string, toPath: string): Promise<void> {
    const from = this.assertContained(fromPath, "rename (from)");
    const to = this.assertContained(toPath, "rename (to)");
    await this.assertRealPathContained(from, "rename (from)");
    await this.assertDestinationContained(to, "rename (to)");
    try {
      await fs.promises.rename(from, to);
    } catch (error) {
      throw this.redact(error, "rename");
    }
  }

  async unlink(targetPath: string): Promise<void> {
    const resolved = this.assertContained(targetPath, "unlink");
    await this.assertRealPathContained(resolved, "unlink");
    try {
      await fs.promises.unlink(resolved);
    } catch (error) {
      throw this.redact(error, "unlink");
    }
  }

  /** Returns `false` only for a genuinely nonexistent path (`ENOENT`/`ENOTDIR`); any other error (permission denied, I/O error, etc.) is a real failure and throws (redacted) rather than being silently reported as "doesn't exist". */
  async exists(targetPath: string): Promise<boolean> {
    const resolved = this.assertContained(targetPath, "exists");
    // Fails closed (throws) if `resolved` exists but a symlink somewhere along it resolves outside
    // the owned root -- closure review item 5: `access()` alone follows symlinks transparently and
    // would otherwise happily report `true` for a path that only "exists" via an escaping link.
    // A no-op for a genuinely nonexistent path (nothing to resolve yet).
    await this.assertRealPathContained(resolved, "exists");
    try {
      await fs.promises.access(resolved);
      return true;
    } catch (error) {
      const code = this.errnoCode(error);
      if (code === "ENOENT" || code === "ENOTDIR") return false;
      throw this.redact(error, "exists");
    }
  }

  async readdir(dirPath: string): Promise<string[]> {
    const resolved = this.assertContained(dirPath, "readdir");
    await this.assertRealPathContained(resolved, "readdir");
    try {
      return await fs.promises.readdir(resolved);
    } catch (error) {
      if (this.errnoCode(error) === "ENOENT") return [];
      throw this.redact(error, "readdir");
    }
  }

  async fsync(targetPath: string): Promise<void> {
    const resolved = this.assertContained(targetPath, "fsync");
    await this.assertRealPathContained(resolved, "fsync");
    const handle = await this.openContained(resolved, fs.constants.O_RDWR, "fsync");
    try {
      await handle.sync();
    } catch (error) {
      throw this.redact(error, "fsync");
    } finally {
      await this.closeHandle(handle, "fsync");
    }
  }

  async fsyncDir(dirPath: string): Promise<void> {
    const resolved = this.assertContained(dirPath, "fsyncDir");
    await this.assertRealPathContained(resolved, "fsyncDir");
    try {
      const handle = await fs.promises.open(resolved, "r");
      try {
        await handle.sync();
      } finally {
        await this.closeHandle(handle, "fsyncDir");
      }
    } catch (error) {
      throw this.redact(error, "fsyncDir");
    }
  }

  async mkdir(dirPath: string): Promise<void> {
    const resolved = this.assertContained(dirPath, "mkdir");
    await this.assertDestinationContained(resolved, "mkdir");
    try {
      await fs.promises.mkdir(resolved, { recursive: true });
    } catch (error) {
      throw this.redact(error, "mkdir");
    }
  }

  /** Non-recursive: rejects if `dirPath` still has children, mirroring `fs.promises.rmdir`'s default semantics exactly. */
  async rmdir(dirPath: string): Promise<void> {
    const resolved = this.assertContained(dirPath, "rmdir");
    await this.assertRealPathContained(resolved, "rmdir");
    try {
      await fs.promises.rmdir(resolved);
    } catch (error) {
      throw this.redact(error, "rmdir");
    }
  }

  async readFileBytes(targetPath: string): Promise<Uint8Array> {
    const resolved = this.assertContained(targetPath, "readFileBytes");
    await this.assertRealPathContained(resolved, "readFileBytes");
    const handle = await this.openContained(resolved, fs.constants.O_RDONLY, "readFileBytes");
    try {
      const stat = await handle.stat();
      this.assertBoundedStatSize(stat.size, "readFileBytes");
      const buffer = await handle.readFile();
      return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    } catch (error) {
      throw this.redact(error, "readFileBytes");
    } finally {
      await this.closeHandle(handle, "readFileBytes");
    }
  }

  async writeFileBytes(targetPath: string, bytes: Uint8Array): Promise<void> {
    const resolved = this.assertContained(targetPath, "writeFileBytes");
    await this.assertDestinationContained(resolved, "writeFileBytes");
    try {
      await fs.promises.mkdir(path.dirname(resolved), { recursive: true });
    } catch (error) {
      throw this.redact(error, "writeFileBytes");
    }
    const handle = await this.openContained(resolved, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC, "writeFileBytes");
    try {
      await handle.writeFile(bytes);
    } catch (error) {
      throw this.redact(error, "writeFileBytes");
    } finally {
      await this.closeHandle(handle, "writeFileBytes");
    }
  }

  async readFileBytesRange(targetPath: string, offset: number, length: number): Promise<Uint8Array> {
    const resolved = this.assertContained(targetPath, "readFileBytesRange");
    await this.assertRealPathContained(resolved, "readFileBytesRange");
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) {
      throw new NodeFsContainmentError("readFileBytesRange requires non-negative safe-integer offset/length.");
    }
    if (length > MAX_BOUNDED_READ_BYTES) {
      throw new NodeFsContainmentError(`readFileBytesRange requested length exceeds the bounded maximum (${length} > ${MAX_BOUNDED_READ_BYTES} bytes).`);
    }
    if (!Number.isSafeInteger(offset + length)) {
      throw new NodeFsContainmentError("readFileBytesRange offset+length overflows the safe-integer range.");
    }
    const handle = await this.openContained(resolved, fs.constants.O_RDONLY, "readFileBytesRange");
    try {
      const stat = await handle.stat();
      // Only the file's SIZE SHAPE is validated here (non-negative safe integer) -- deliberately
      // NOT `assertBoundedStatSize`, which would reject a legitimate large index artifact (a
      // `.mvx` shard can be hundreds of MiB) purely because the WHOLE FILE exceeds
      // MAX_BOUNDED_READ_BYTES, even for a tiny bounded range read out of it (closure review item
      // 5 -- this was a real regression). The REQUESTED length is what stays bounded, checked
      // above before this handle was even opened.
      this.assertValidSize(stat.size, "readFileBytesRange");
      if (offset + length > stat.size) {
        throw new NodeFsContainmentError("readFileBytesRange requested a range beyond the end of the file.");
      }
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      if (bytesRead !== length) {
        throw new NodeFsContainmentError("readFileBytesRange received a short read from the underlying filesystem.");
      }
      return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    } catch (error) {
      throw this.redact(error, "readFileBytesRange");
    } finally {
      await this.closeHandle(handle, "readFileBytesRange");
    }
  }

  async statSize(targetPath: string): Promise<number> {
    const resolved = this.assertContained(targetPath, "statSize");
    await this.assertRealPathContained(resolved, "statSize");
    const handle = await this.openContained(resolved, fs.constants.O_RDONLY, "statSize");
    let size: number;
    try {
      size = (await handle.stat()).size;
    } catch (error) {
      throw this.redact(error, "statSize");
    } finally {
      await this.closeHandle(handle, "statSize");
    }
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new NodeFsContainmentError("statSize target reported an invalid size.");
    }
    return size;
  }
}

/**
 * Bounded read helper for callers (e.g. preflight) that want to read a
 * small file without allocating for an unexpectedly huge one -- rejects
 * before reading the whole file into memory if it exceeds `maxBytes`.
 */
export async function readBoundedTextFile(fsAdapter: NodeOwnedFs, absolutePath: string, maxBytes: number = MAX_BOUNDED_READ_BYTES): Promise<string> {
  const size = await fsAdapter.statSize(absolutePath);
  if (size > maxBytes) {
    throw new NodeFsContainmentError(`File exceeds bounded read size (${size} > ${maxBytes} bytes).`);
  }
  return fsAdapter.readFile(absolutePath);
}
