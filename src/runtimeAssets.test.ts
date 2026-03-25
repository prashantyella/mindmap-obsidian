import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { ensureBundledRuntimeAssets, type BundledRuntimeAssets, type RuntimeAssetFs } from "./runtimeAssets";

class MemoryFs implements RuntimeAssetFs {
  readonly files = new Map<string, string>();
  failWrites = false;

  constructor(initialFiles: Record<string, string> = {}) {
    for (const [filePath, content] of Object.entries(initialFiles)) {
      this.files.set(path.normalize(filePath), content);
    }
  }

  existsSync(targetPath: string): boolean {
    return this.files.has(path.normalize(targetPath));
  }

  async mkdir(_targetPath: string, _options: { recursive: boolean }): Promise<void> {
    return;
  }

  async writeFile(targetPath: string, content: string, _encoding: BufferEncoding): Promise<void> {
    if (this.failWrites) {
      throw new Error("disk full");
    }
    this.files.set(path.normalize(targetPath), content);
  }
}

const assets: BundledRuntimeAssets = {
  "mindmap.py": "print('mindmap')\n",
  "requirements.txt": "chromadb\n",
  "config.template.json": '{"vault_root":"../.."}\n',
};

test("ensureBundledRuntimeAssets repairs missing runtime files and creates config.json", async () => {
  const runtimeDir = path.normalize("/vault/.obsidian/plugins/mindmap-obsidian/python");
  const fs = new MemoryFs();

  const result = await ensureBundledRuntimeAssets(runtimeDir, assets, fs);

  assert.equal(result.ok, true);
  assert.deepEqual(result.recovered.sort(), ["config.template.json", "mindmap.py", "requirements.txt"]);
  assert.equal(result.configCreated, true);
  assert.equal(fs.files.get(path.join(runtimeDir, "mindmap.py")), assets["mindmap.py"]);
  assert.equal(fs.files.get(path.join(runtimeDir, "requirements.txt")), assets["requirements.txt"]);
  assert.equal(fs.files.get(path.join(runtimeDir, "config.template.json")), assets["config.template.json"]);
  assert.equal(fs.files.get(path.join(runtimeDir, "config.json")), assets["config.template.json"]);
});

test("ensureBundledRuntimeAssets leaves existing runtime files untouched", async () => {
  const runtimeDir = path.normalize("/vault/.obsidian/plugins/mindmap-obsidian/python");
  const fs = new MemoryFs({
    [path.join(runtimeDir, "mindmap.py")]: "custom script\n",
    [path.join(runtimeDir, "requirements.txt")]: "custom req\n",
    [path.join(runtimeDir, "config.template.json")]: "custom template\n",
    [path.join(runtimeDir, "config.json")]: "custom config\n",
  });

  const result = await ensureBundledRuntimeAssets(runtimeDir, assets, fs);

  assert.equal(result.ok, true);
  assert.deepEqual(result.recovered, []);
  assert.equal(result.configCreated, false);
  assert.equal(fs.files.get(path.join(runtimeDir, "mindmap.py")), "custom script\n");
  assert.equal(result.message, "Mindmap runtime assets verified.");
});

test("ensureBundledRuntimeAssets reports actionable failure when writing bundled assets fails", async () => {
  const runtimeDir = path.normalize("/vault/.obsidian/plugins/mindmap-obsidian/python");
  const fs = new MemoryFs();
  fs.failWrites = true;

  const result = await ensureBundledRuntimeAssets(runtimeDir, assets, fs);

  assert.equal(result.ok, false);
  assert.match(result.message, /could not restore mindmap.py/i);
  assert.match(result.message, /disk full/i);
});
