# Overlay Metadata Cap Design

**Date:** 2026-09-14
**Branch:** `fix/overlay-metadata-cap`

---

## Problem

`encodeMetadataJsonOrThrow` (`overlayStore.ts:130`) enforces
`OVERLAY_METADATA_JSON_MAX_BYTES` (512, `budgets.ts:164`) on the UTF-8 byte
length of the overlay metadata JSON before any write. Current valid notes with
155-byte paths produce 513-515 bytes of metadata, exceeding the cap.

The rejection throws `OverlayStoreError`. `IndexStore.upsertNote`
(`indexStore.ts:1000-1003`) catches it via `wrapOverlayError`
(`indexStore.ts:73`), which converts every thrown value to `IndexStoreError`.
Neither `OverlayStoreError` nor `IndexStoreError` is an `EngineError`, so
`toFailureCode` (`jobTypes.ts:174`) redacts to `"UNKNOWN_TRANSIENT"`. The job
retries 20 times against a deterministic failure.

A direct `EngineError` at the encode site does not help: `wrapOverlayError`
wraps it into `IndexStoreError` before it reaches `toFailureCode`.

## Design

### 1. Raise `OVERLAY_METADATA_JSON_MAX_BYTES` from 512 to 4096

Current 513-515 byte metadata succeeds immediately. No files need renaming.

### 2. Add terminal code `OVERLAY_METADATA_TOO_LARGE` for metadata above 4096

Throw `OverlayMetadataTooLargeError extends OverlayStoreError` in
`encodeMetadataJsonOrThrow` when metadata exceeds 4096 bytes. In
`wrapOverlayError`, detect that subtype FIRST and convert to a privacy-safe
`EngineError("OVERLAY_METADATA_TOO_LARGE", <generic message>, {})`. All other
overlay and I/O errors remain `IndexStoreError` (transient).

```
encodeMetadataJsonOrThrow  →  throws OverlayMetadataTooLargeError
    ↓
writeUpsertOverlay         →  propagates unchanged
    ↓
upsertNote catch           →  wrapOverlayError detects subtype FIRST
    ↓
wrapOverlayError           →  EngineError("OVERLAY_METADATA_TOO_LARGE")
    ↓
noteJob.providerFailureOutcome  →  toFailureCode recognises it
    ↓
classifyFailureCode        →  "terminal"
    ↓
applyStepOutcome           →  status: "failed", attempt 1
```

Add `"OVERLAY_METADATA_TOO_LARGE"` to `ENGINE_ERROR_CODES` (`errors.ts`) and
`KNOWN_TERMINAL_FAILURE_CODES` (`jobTypes.ts`). Never add to
`PROVIDER_WIDE_PAUSE_CODES`.

### 3. Budget impact

The cap increase affects overlay disk accounting only.
`computeSteadyStateBytesWithOverlays` does not use the metadata cap.

Disk delta: `2000 * (4096 - 512)` = **7,168,000 bytes** (6.84 MiB).
Total disk at target scale (10k notes, 100k chunks, 1024 dimensions) rises from
524.95 MiB to 531.78 MiB. The 600 MiB ceiling holds with 68.22 MiB headroom.

## Tests

1. **Current paths succeed.** 155-byte ASCII and curly-apostrophe UTF-8 paths
   producing 513-515 bytes of metadata now write successfully after the cap
   increase.

2. **Boundary: 4096 accepted, 4097 rejected.** Exact 4096-byte metadata writes
   successfully. 4097-byte metadata throws `OverlayMetadataTooLargeError` at the
   overlay store layer.

3. **IndexStore converts subtype.** `IndexStore.upsertNote` with > 4096-byte
   metadata throws `EngineError` with code `"OVERLAY_METADATA_TOO_LARGE"` (not
   `IndexStoreError`).

4. **One-attempt terminal.** A note job exceeding the cap reaches
   `status: "failed"` after exactly 1 attempt with persisted failure code
   `"OVERLAY_METADATA_TOO_LARGE"`.

5. **Disk accounting delta.** `computeOverlayDiskBytesBudget` increases by
   exactly 7,168,000 bytes. Total disk with overlays remains ≤ 600 MiB.
   Steady-state and rebuild-peak ceilings are unchanged.

6. **Ordinary writes unaffected.** A note with a short path writes through the
   full `upsertNote` → `writeUpsertOverlay` → `AtomicBinaryStore.save` path and
   completes normally.

## Recovery

Recovery is a fresh pending/scope run, never queue editing.

Terminal jobs do not coalesce (`appendOrCoalesce` checks
`!isTerminalJobStatus`), so a fresh pending scan or scope-refresh submits new
jobs for any note not in the committed catalog. Current 513-515 byte paths
succeed without renaming after the cap increase. Only a future note exceeding
4096 bytes would require shortening.

## Operational notes

### Release 0.3.4

After implementation, testing, and merge, tag and release 0.3.4. User-controlled
step.

### Pause / run

`PROVIDER_WIDE_PAUSE_CODES` must NOT include `OVERLAY_METADATA_TOO_LARGE`.
Per-note condition, not provider misconfiguration. Pausing and resuming remain
user-controlled.
