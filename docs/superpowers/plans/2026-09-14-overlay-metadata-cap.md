# Overlay Metadata Cap Implementation Plan

## Goal

Raise `OVERLAY_METADATA_JSON_MAX_BYTES` from 512 to 4096 so current 513-515
byte metadata succeeds, and add a typed terminal error
(`OVERLAY_METADATA_TOO_LARGE`) for metadata above 4096, preserved through
`overlayStore` → `indexStore` → `NoteJob` instead of `UNKNOWN_TRANSIENT`.

Design: `docs/superpowers/specs/2026-09-14-overlay-metadata-cap-design.md`

## Constraints

- No queue edits, resets, or production state changes.
- All other overlay/I/O errors remain `IndexStoreError` (transient).
- Never add `OVERLAY_METADATA_TOO_LARGE` to `PROVIDER_WIDE_PAUSE_CODES`.
- `npm run check` must pass at each checkpoint acceptance.
- Focused tests: `npx tsx --import ./scripts/test-setup.mjs --test <files>`.

---

## Checkpoint 1 — Cap increase and disk budget

Files:
- `src/index/budgets.ts` — change `OVERLAY_METADATA_JSON_MAX_BYTES` from 512 to
  4096
- `src/index/budgets.test.ts` — add test asserting `computeOverlayDiskBytesBudget`
  increases by exactly 7,168,000 bytes versus the old 512 value; assert
  `computeDiskBytesWithOverlays` at target scale (10k notes, 100k chunks, 1024
  dimensions) remains ≤ `BUDGET_DISK_BYTES` (600 MiB); assert steady-state and
  rebuild-peak ceilings are unchanged (they do not reference the metadata cap)

Focused test:
```
npx tsx --import ./scripts/test-setup.mjs --test src/index/budgets.test.ts
```

Accept: `npm run check`

---

## Checkpoint 2 — Error subtype, IndexStore conversion, terminal registration

Files:
- `src/index/overlayStore.ts` — export `OverlayMetadataTooLargeError extends
  OverlayStoreError`; in `encodeMetadataJsonOrThrow`, throw that subtype
  instead of `OverlayStoreError` when metadata exceeds the cap
- `src/index/indexStore.ts` — in `wrapOverlayError`, detect
  `OverlayMetadataTooLargeError` FIRST (before the generic `OverlayStoreError`
  branch) and return `EngineError("OVERLAY_METADATA_TOO_LARGE", "overlay
  metadata JSON exceeds the enforced byte cap", {})` instead of
  `IndexStoreError`; all other errors remain `IndexStoreError`
- `src/engine/errors.ts` — append `"OVERLAY_METADATA_TOO_LARGE"` to
  `ENGINE_ERROR_CODES`
- `src/jobs/jobTypes.ts` — add `"OVERLAY_METADATA_TOO_LARGE"` to
  `KNOWN_TERMINAL_FAILURE_CODES`; do NOT add to `PROVIDER_WIDE_PAUSE_CODES`

Focused test:
```
npx tsx --import ./scripts/test-setup.mjs --test src/index/overlayStore.test.ts src/index/indexStore.test.ts
```

Accept: `npm run check`

---

## Checkpoint 3 — Boundary and one-attempt tests

Files:
- `src/index/overlayStore.test.ts` — add tests:
  - 155-byte ASCII path producing 513-515 bytes: `writeUpsertOverlay` succeeds,
    overlay readable with correct identity
  - Curly-apostrophe UTF-8 path producing 513-515 bytes: same assertion
  - Exact 4096-byte metadata JSON: `writeUpsertOverlay` succeeds
  - 4097-byte metadata JSON: throws `OverlayMetadataTooLargeError`
- `src/index/indexStore.test.ts` — add test:
  - `IndexStore.upsertNote` with > 4096-byte metadata throws `EngineError` with
    code `"OVERLAY_METADATA_TOO_LARGE"`
- `src/jobs/noteJob.test.ts` — add test:
  - Note job with > 4096-byte identity reaches `status: "failed"` after exactly
    1 attempt with persisted failure code `"OVERLAY_METADATA_TOO_LARGE"`
- `src/index/overlayStore.test.ts` — add test:
  - Short-path note (`"Notes/Daily/2026-09-14.md"`) writes through
    `writeUpsertOverlay` successfully (ordinary writes unaffected)

Focused test:
```
npx tsx --import ./scripts/test-setup.mjs --test src/index/overlayStore.test.ts src/index/indexStore.test.ts src/jobs/noteJob.test.ts
```

Accept: `npm run check`

---

## Checkpoint 4 — Full gates, security, privacy, source audit

No new files. Review pass over checkpoints 1-3:

- `npm run check` (type-check + all tests)
- Verify `EngineError` context is `{}` — no note content, file paths, or byte
  counts leak into persisted store
- Verify `toFailureCode` path: only `EngineError` instances with recognised
  codes are ever persisted; `OVERLAY_METADATA_TOO_LARGE` is in
  `ENGINE_ERROR_CODES` AND `KNOWN_TERMINAL_FAILURE_CODES`; NOT in
  `PROVIDER_WIDE_PAUSE_CODES`
- Verify `wrapOverlayError` ordering: subtype check before generic
  `OverlayStoreError` branch; all other overlay/I/O errors still become
  `IndexStoreError` (transient)
- Verify no `OverlayMetadataTooLargeError` escapes `wrapOverlayError` into
  `NoteJob` — only `EngineError` reaches `toFailureCode`
- Verify disk budget arithmetic: delta is exactly 7,168,000 bytes; total under
  600 MiB; steady-state and rebuild-peak unchanged

```
npm run check
```

---

## Checkpoint 5 — 0.3.4 PR/release and recovery (operational, later)

User-controlled steps, not part of implementation checkpoints:

- Create PR from `fix/overlay-metadata-cap` to `main`
- After merge, tag 0.3.4, create GitHub release
- Recovery: user triggers a fresh pending scan or scope-refresh run; terminal
  jobs do not coalesce, so new jobs are submitted for previously failed notes;
  current 513-515 byte paths succeed without renaming
