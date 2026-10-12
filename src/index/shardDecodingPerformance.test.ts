import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";

import { NodeOwnedFs } from "../engine/nodeFs";
import { checksumHex, checksumHexCooperatively, decodeVectorMatrix, decodeVectorMatrixCooperatively, encodeVectorMatrix, type VectorCodecStageMeasurement } from "./vectorCodec";

void test("opt-in same-fixture synchronous/cooperative shard stage benchmark", { skip: process.env.MINDMAP_RUN_SHARD_BENCHMARK !== "1" }, async () => {
  const dimension = 1_024;
  const count = 10_000;
  const data = new Float32Array(dimension * count);
  for (let row = 0; row < count; row += 1) data[row * dimension + (row % dimension)] = 1;
  const encoded = encodeVectorMatrix({ kind: "chunk", dimension, count, data });
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mindmap-shard-stages-"));
  try {
    const adapter = new NodeOwnedFs(root);
    const filePath = path.join(root, "shard.mvx");
    await adapter.writeFileBytes(filePath, encoded);
    const readStarted = performance.now();
    const bytes = await adapter.readFileBytes(filePath);
    const readWallMs = performance.now() - readStarted;

    const syncHashStarted = performance.now();
    const syncManifestHash = checksumHex(bytes);
    const syncManifestHashMs = performance.now() - syncHashStarted;
    const syncDecodeStarted = performance.now();
    const sync = decodeVectorMatrix(bytes, { expectedKind: "chunk" });
    const syncDecodeMs = performance.now() - syncDecodeStarted;

    const stages: VectorCodecStageMeasurement[] = [];
    const delay = monitorEventLoopDelay({ resolution: 1 });
    delay.enable();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const asyncDecodeStarted = performance.now();
    const cooperative = await decodeVectorMatrixCooperatively(bytes, { expectedKind: "chunk", ownedBufferView: true, onStage: (stage) => stages.push(stage) });
    const asyncDecodeWallMs = performance.now() - asyncDecodeStarted;
    const asyncHashStarted = performance.now();
    const asyncManifestHash = await checksumHexCooperatively(bytes, { onStage: (stage) => stages.push(stage) });
    const asyncManifestHashWallMs = performance.now() - asyncHashStarted;
    await new Promise<void>((resolve) => setImmediate(resolve));
    delay.disable();

    assert.equal(asyncManifestHash, syncManifestHash);
    assert.deepEqual([...cooperative.data.subarray(0, dimension * 2)], [...sync.data.subarray(0, dimension * 2)]);
    const output = {
      bytes: bytes.byteLength,
      readWallMs: Number(readWallMs.toFixed(2)),
      syncManifestHashMs: Number(syncManifestHashMs.toFixed(2)),
      syncEmbeddedHashValidationCopyMs: Number(syncDecodeMs.toFixed(2)),
      cooperativeDecodeWallMs: Number(asyncDecodeWallMs.toFixed(2)),
      cooperativeManifestHashWallMs: Number(asyncManifestHashWallMs.toFixed(2)),
      maxSynchronousSliceMs: Number(Math.max(...stages.map((stage) => stage.maxSynchronousSliceMs)).toFixed(2)),
      eventLoopDelayMs: Number((delay.max / 1e6).toFixed(2)),
      stageMeasurements: stages.map((stage) => ({ ...stage, wallMs: Number(stage.wallMs.toFixed(2)), maxSynchronousSliceMs: Number(stage.maxSynchronousSliceMs.toFixed(2)) })),
      usedOwnedView: stages.find((stage) => stage.stage === "validation-materialization")?.usedOwnedView ?? false,
      snapshotCopyWallMs: stages.find((stage) => stage.stage === "snapshot-copy")?.wallMs ?? 0,
      retainedBackingMiB: Number((bytes.byteLength / 1024 / 1024).toFixed(2)),
      runtime: process.version,
      hardware: `${os.cpus()[0]?.model ?? "unknown"}; ${os.cpus().length} logical CPUs`,
    };
    process.stdout.write(`SHARD_STAGE_BENCHMARK ${JSON.stringify(output)}\n`);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});
