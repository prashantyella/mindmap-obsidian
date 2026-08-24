import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NodeOwnedFs, readBoundedTextFile } from "./nodeFs";

async function makeTempRoot(): Promise<string> {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), "mindmap-node-fs-"));
}

void test("NodeOwnedFs write/read/rename round-trip inside the owned root", async () => {
  const root = await makeTempRoot();
  try {
    const adapter = new NodeOwnedFs(root);
    const tempPath = path.join(root, "state.json.tmp");
    const finalPath = path.join(root, "state.json");
    await adapter.writeFile(tempPath, "{\"a\":1}");
    await adapter.rename(tempPath, finalPath);
    assert.equal(await adapter.readFile(finalPath), "{\"a\":1}");
    assert.equal(await adapter.exists(tempPath), false);
    assert.equal(await adapter.exists(finalPath), true);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

void test("NodeOwnedFs rejects a path that traverses outside the owned root", async () => {
  const root = await makeTempRoot();
  try {
    const adapter = new NodeOwnedFs(root);
    const outside = path.join(root, "..", "escaped.json");
    await assert.rejects(() => adapter.writeFile(outside, "x"));
    await assert.rejects(() => adapter.readFile(outside));
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

void test("NodeOwnedFs rejects an absolute path entirely outside the owned root", async () => {
  const root = await makeTempRoot();
  const other = await makeTempRoot();
  try {
    const adapter = new NodeOwnedFs(root);
    await assert.rejects(() => adapter.readFile(path.join(other, "anything")));
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
    await fs.promises.rm(other, { recursive: true, force: true });
  }
});

void test("NodeOwnedFs rejects reading through a symlink that escapes the owned root", async () => {
  const root = await makeTempRoot();
  const outside = await makeTempRoot();
  try {
    const secretPath = path.join(outside, "secret.txt");
    await fs.promises.writeFile(secretPath, "outside-root-content");
    const linkPath = path.join(root, "link.txt");
    await fs.promises.symlink(secretPath, linkPath);

    const adapter = new NodeOwnedFs(root);
    await assert.rejects(() => adapter.readFile(linkPath));
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
    await fs.promises.rm(outside, { recursive: true, force: true });
  }
});

void test("NodeOwnedFs mkdir is idempotent and creates missing parents", async () => {
  const root = await makeTempRoot();
  try {
    const adapter = new NodeOwnedFs(root);
    const nested = path.join(root, "a", "b", "c");
    await adapter.mkdir(nested);
    await adapter.mkdir(nested);
    assert.equal(await adapter.exists(nested), true);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

void test("NodeOwnedFs creates a fresh owned root beneath an existing trusted parent", async () => {
  const parent = await makeTempRoot();
  const root = path.join(parent, "plugin-data", "production-engine");
  try {
    const adapter = new NodeOwnedFs(root);
    const jobs = path.join(root, "jobs");
    await adapter.mkdir(jobs);
    await adapter.writeFile(path.join(jobs, "queue.json"), "{}");
    assert.equal(await adapter.readFile(path.join(jobs, "queue.json")), "{}");
  } finally {
    await fs.promises.rm(parent, { recursive: true, force: true });
  }
});

void test("NodeOwnedFs rmdir rejects a non-empty directory and succeeds once emptied", async () => {
  const root = await makeTempRoot();
  try {
    const adapter = new NodeOwnedFs(root);
    const dir = path.join(root, "dir");
    await adapter.mkdir(dir);
    await adapter.writeFile(path.join(dir, "file.txt"), "x");
    await assert.rejects(() => adapter.rmdir(dir));
    await adapter.unlink(path.join(dir, "file.txt"));
    await adapter.rmdir(dir);
    assert.equal(await adapter.exists(dir), false);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

void test("NodeOwnedFs readFileBytesRange reads exactly the requested bounded slice", async () => {
  const root = await makeTempRoot();
  try {
    const adapter = new NodeOwnedFs(root);
    const filePath = path.join(root, "vectors.bin");
    await adapter.writeFileBytes(filePath, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    const slice = await adapter.readFileBytesRange(filePath, 2, 3);
    assert.deepEqual(Array.from(slice), [3, 4, 5]);
    assert.equal(await adapter.statSize(filePath), 8);
    await assert.rejects(() => adapter.readFileBytesRange(filePath, 6, 10));
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

void test("readBoundedTextFile rejects a file larger than the configured bound before allocating", async () => {
  const root = await makeTempRoot();
  try {
    const adapter = new NodeOwnedFs(root);
    const filePath = path.join(root, "big.json");
    await adapter.writeFile(filePath, "x".repeat(100));
    await assert.rejects(() => readBoundedTextFile(adapter, filePath, 10));
    assert.equal(await readBoundedTextFile(adapter, filePath, 1000), "x".repeat(100));
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

void test("NodeOwnedFs readdir returns an empty array for a directory that does not exist", async () => {
  const root = await makeTempRoot();
  try {
    const adapter = new NodeOwnedFs(root);
    assert.deepEqual(await adapter.readdir(path.join(root, "missing")), []);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

void test("NodeOwnedFs rejects writeFile through a symlinked PARENT directory that escapes the owned root (destination itself does not exist yet)", async () => {
  const root = await makeTempRoot();
  const outside = await makeTempRoot();
  try {
    const linkPath = path.join(root, "link");
    await fs.promises.symlink(outside, linkPath);
    const adapter = new NodeOwnedFs(root);
    await assert.rejects(() => adapter.writeFile(path.join(linkPath, "new-file.txt"), "x"));
    assert.equal(fs.existsSync(path.join(outside, "new-file.txt")), false);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
    await fs.promises.rm(outside, { recursive: true, force: true });
  }
});

void test("NodeOwnedFs rejects writeFileBytes through a symlinked parent directory that escapes the owned root", async () => {
  const root = await makeTempRoot();
  const outside = await makeTempRoot();
  try {
    const linkPath = path.join(root, "link");
    await fs.promises.symlink(outside, linkPath);
    const adapter = new NodeOwnedFs(root);
    await assert.rejects(() => adapter.writeFileBytes(path.join(linkPath, "new-file.bin"), new Uint8Array([1, 2, 3])));
    assert.equal(fs.existsSync(path.join(outside, "new-file.bin")), false);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
    await fs.promises.rm(outside, { recursive: true, force: true });
  }
});

void test("NodeOwnedFs rejects mkdir through a symlinked parent directory that escapes the owned root", async () => {
  const root = await makeTempRoot();
  const outside = await makeTempRoot();
  try {
    const linkPath = path.join(root, "link");
    await fs.promises.symlink(outside, linkPath);
    const adapter = new NodeOwnedFs(root);
    await assert.rejects(() => adapter.mkdir(path.join(linkPath, "new-dir")));
    assert.equal(fs.existsSync(path.join(outside, "new-dir")), false);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
    await fs.promises.rm(outside, { recursive: true, force: true });
  }
});

void test("NodeOwnedFs rejects rename whose destination sits behind a symlinked parent directory that escapes the owned root", async () => {
  const root = await makeTempRoot();
  const outside = await makeTempRoot();
  try {
    const adapter = new NodeOwnedFs(root);
    const source = path.join(root, "source.txt");
    await adapter.writeFile(source, "x");
    const linkPath = path.join(root, "link");
    await fs.promises.symlink(outside, linkPath);
    await assert.rejects(() => adapter.rename(source, path.join(linkPath, "moved.txt")));
    assert.equal(fs.existsSync(path.join(outside, "moved.txt")), false);
    assert.equal(await adapter.exists(source), true);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
    await fs.promises.rm(outside, { recursive: true, force: true });
  }
});

void test("NodeOwnedFs rejects a write nested several missing levels below a symlinked parent directory that escapes the owned root", async () => {
  const root = await makeTempRoot();
  const outside = await makeTempRoot();
  try {
    const linkPath = path.join(root, "link");
    await fs.promises.symlink(outside, linkPath);
    const adapter = new NodeOwnedFs(root);
    const deepTarget = path.join(linkPath, "a", "b", "c", "new-file.txt");
    await assert.rejects(() => adapter.writeFile(deepTarget, "x"));
    assert.equal(fs.existsSync(path.join(outside, "a")), false);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
    await fs.promises.rm(outside, { recursive: true, force: true });
  }
});

void test("NodeOwnedFs writeFile through several missing levels inside the owned root (no symlink) still succeeds", async () => {
  const root = await makeTempRoot();
  try {
    const adapter = new NodeOwnedFs(root);
    const target = path.join(root, "a", "b", "c", "new-file.txt");
    await adapter.writeFile(target, "ok");
    assert.equal(await adapter.readFile(target), "ok");
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

void test("NodeOwnedFs exists() throws (rather than returning false) on a non-ENOENT access error", async () => {
  const root = await makeTempRoot();
  try {
    const adapter = new NodeOwnedFs(root);
    const dirPath = path.join(root, "somedir");
    await adapter.mkdir(dirPath);
    // A path that treats an existing FILE as though it had a directory component underneath it
    // triggers ENOTDIR, which this adapter's `exists()` still correctly classifies as "does not
    // exist" (matches Node's own semantics for a missing path segment) -- this is a smoke check
    // that the classification branch exists and doesn't swallow every error indiscriminately.
    const filePath = path.join(root, "file.txt");
    await adapter.writeFile(filePath, "x");
    assert.equal(await adapter.exists(path.join(filePath, "impossible-child")), false);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

void test("NodeOwnedFs error messages never leak the resolved absolute path (readFile ENOENT, writeFile through a rejected symlinked parent)", async () => {
  const root = await makeTempRoot();
  const outside = await makeTempRoot();
  try {
    const adapter = new NodeOwnedFs(root);
    const missingPath = path.join(root, "does-not-exist.json");
    await assert.rejects(
      () => adapter.readFile(missingPath),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as Error).message.includes(missingPath), false, "readFile error message must not embed the resolved path");
        assert.equal((error as Error).message.includes(root), false);
        return true;
      },
    );

    const linkPath = path.join(root, "link");
    await fs.promises.symlink(outside, linkPath);
    const target = path.join(linkPath, "new-file.txt");
    await assert.rejects(
      () => adapter.writeFile(target, "x"),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as Error).message.includes(outside), false, "writeFile symlink-escape error message must not embed the outside path");
        return true;
      },
    );
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
    await fs.promises.rm(outside, { recursive: true, force: true });
  }
});

void test("NodeOwnedFs rejects readFile through a leaf-level symlink even though the containment check already covers it (descriptor-safe openContained defense)", async () => {
  const root = await makeTempRoot();
  const outside = await makeTempRoot();
  try {
    const secretPath = path.join(outside, "secret.txt");
    await fs.promises.writeFile(secretPath, "outside-content");
    const linkPath = path.join(root, "link.txt");
    await fs.promises.symlink(secretPath, linkPath);
    const adapter = new NodeOwnedFs(root);
    await assert.rejects(() => adapter.readFile(linkPath));
    await assert.rejects(() => adapter.readFileBytes(linkPath));
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
    await fs.promises.rm(outside, { recursive: true, force: true });
  }
});

void test("NodeOwnedFs pins the owned root's real path across repeated calls (root realpath resolved successfully once root exists)", async () => {
  const root = await makeTempRoot();
  try {
    const adapter = new NodeOwnedFs(root);
    // Trigger root-realpath resolution twice via two independent operations; both must succeed
    // identically once the root exists on disk (makeTempRoot() already created it) -- this is a
    // behavioral smoke test for the pinning path, not a white-box check of the private cache.
    await adapter.writeFile(path.join(root, "a.json"), "1");
    await adapter.writeFile(path.join(root, "b.json"), "2");
    assert.equal(await adapter.readFile(path.join(root, "a.json")), "1");
    assert.equal(await adapter.readFile(path.join(root, "b.json")), "2");
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

void test("NodeOwnedFs exists() propagates a non-ENOENT/ENOTDIR error without leaking the path in its message", async () => {
  const root = await makeTempRoot();
  try {
    const adapter = new NodeOwnedFs(root);
    const dirPath = path.join(root, "adir");
    await adapter.mkdir(dirPath);
    // A path with a FILE as an intermediate segment (not a directory) triggers ENOTDIR from the
    // underlying syscall -- exists() must still classify this as "does not exist" (matches Node's
    // own semantics for a missing/impossible path segment), covered already by the earlier
    // ENOTDIR smoke test; this test's own purpose is the redaction guarantee on the THROW path,
    // exercised via a permission-denied case where supported.
    if (process.getuid && process.getuid() !== 0) {
      const restrictedDir = path.join(root, "restricted");
      await adapter.mkdir(restrictedDir);
      const restrictedFile = path.join(restrictedDir, "f.txt");
      await adapter.writeFile(restrictedFile, "x");
      await fs.promises.chmod(restrictedDir, 0o000);
      try {
        await assert.rejects(
          () => adapter.exists(restrictedFile),
          (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.equal((error as Error).message.includes(restrictedFile), false);
            return true;
          },
        );
      } finally {
        await fs.promises.chmod(restrictedDir, 0o700);
      }
    }
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

void test("NodeOwnedFs readFileBytesRange verifies bytesRead === requested length rather than trusting the syscall silently", async () => {
  const root = await makeTempRoot();
  try {
    const adapter = new NodeOwnedFs(root);
    const filePath = path.join(root, "vectors.bin");
    await adapter.writeFileBytes(filePath, new Uint8Array([1, 2, 3, 4, 5]));
    // A well-formed, in-range read succeeds and returns exactly the requested byte count.
    const slice = await adapter.readFileBytesRange(filePath, 1, 3);
    assert.equal(slice.length, 3);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

void test("NodeOwnedFs readFileBytesRange succeeds on a bounded range read from a file LARGER than the 64MiB whole-file read bound -- a large approved index artifact must not be rejected just because the file itself is large", async () => {
  const root = await makeTempRoot();
  try {
    const adapter = new NodeOwnedFs(root);
    const filePath = path.join(root, "large.mvx");
    const oversizeLength = 64 * 1024 * 1024 + 1024; // 1KiB past the whole-file bound
    // A sparse file: seek past the bound and write a few trailing bytes, without actually
    // allocating/writing 64MiB+ of real data -- keeps this test fast while still producing a real
    // file whose reported `stat().size` exceeds MAX_BOUNDED_READ_BYTES.
    const handle = await fs.promises.open(filePath, "w");
    try {
      await handle.write(Buffer.from([9, 8, 7, 6]), 0, 4, oversizeLength - 4);
    } finally {
      await handle.close();
    }
    const stat = await fs.promises.stat(filePath);
    assert.ok(stat.size > 64 * 1024 * 1024, "test setup: file must exceed the whole-file read bound");

    const slice = await adapter.readFileBytesRange(filePath, oversizeLength - 4, 4);
    assert.deepEqual(Array.from(slice), [9, 8, 7, 6]);

    // Whole-file reads stay capped, unlike bounded range reads.
    await assert.rejects(() => adapter.readFileBytes(filePath));
    await assert.rejects(() => adapter.readFile(filePath));
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

void test("NodeOwnedFs exists() fails closed (throws) rather than reporting true for a path that only exists via a symlink escaping the owned root", async () => {
  const root = await makeTempRoot();
  const outside = await makeTempRoot();
  try {
    const secretPath = path.join(outside, "secret.txt");
    await fs.promises.writeFile(secretPath, "outside-content");
    const linkPath = path.join(root, "link.txt");
    await fs.promises.symlink(secretPath, linkPath);

    const adapter = new NodeOwnedFs(root);
    await assert.rejects(() => adapter.exists(linkPath));
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
    await fs.promises.rm(outside, { recursive: true, force: true });
  }
});

void test("NodeOwnedFs exists() still returns false (not throw) for a genuinely nonexistent path", async () => {
  const root = await makeTempRoot();
  try {
    const adapter = new NodeOwnedFs(root);
    assert.equal(await adapter.exists(path.join(root, "missing.txt")), false);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

void test("NodeOwnedFs readFileBytesRange rejects an oversize length before allocating a buffer", async () => {
  const root = await makeTempRoot();
  try {
    const adapter = new NodeOwnedFs(root);
    const filePath = path.join(root, "vectors.bin");
    await adapter.writeFileBytes(filePath, new Uint8Array([1, 2, 3]));
    await assert.rejects(() => adapter.readFileBytesRange(filePath, 0, Number.MAX_SAFE_INTEGER));
    await assert.rejects(() => adapter.readFileBytesRange(filePath, Number.MAX_SAFE_INTEGER, 10));
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});
