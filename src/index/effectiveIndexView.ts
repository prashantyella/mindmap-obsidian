import type { NoteIdentityV1 } from "../engine/contracts";
import { EngineError } from "../engine/errors";
import { identityKey, type NoteRowMetadataV1 } from "./generationMetadata";
import type { OverlayPrefixRecord } from "./overlayStore";

/** Resolve logical occupancy once for every consumer. Raw overlays remain owned
 * by the snapshot/cleanup protocol and physical resource accounting.
 *
 * Stable keys follow renames; paths identify the one file currently occupying a
 * location. A path identity and an annotation identity may be legacy aliases.
 * Distinct annotation IDs are not aliases. Overlay versions are per-key, so only
 * recordedAt orders cross-key writes; ties fail closed. Tombstones retain their
 * path claim while replaying, preventing older aliases from being resurrected.
 */
export function effectiveIndexView(base: readonly NoteRowMetadataV1[], overlays: readonly OverlayPrefixRecord[]): {
  base: NoteRowMetadataV1[];
  overlays: OverlayPrefixRecord[];
} {
  type Entry = { identity: NoteIdentityV1; base?: NoteRowMetadataV1; overlay?: OverlayPrefixRecord };
  const byPath = new Map<string, Entry>();
  const byKey = new Map<string, Entry>();
  const conflict = (): never => { throw new EngineError("INDEX_IDENTITY_CONFLICT", "Index identities conflict at a canonical path; rebuild requires identity reconciliation."); };
  const remove = (entry: Entry): void => {
    byPath.delete(entry.identity.canonicalPath);
    byKey.delete(identityKey(entry.identity));
  };
  for (const row of base) {
    if (byPath.has(row.identity.canonicalPath) || byKey.has(identityKey(row.identity))) conflict();
    const entry: Entry = { identity: row.identity, base: row };
    byPath.set(row.identity.canonicalPath, entry);
    byKey.set(identityKey(row.identity), entry);
  }
  for (const overlay of [...overlays].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt) || identityKey(a.identity).localeCompare(identityKey(b.identity)))) {
    const key = identityKey(overlay.identity);
    const sameKey = byKey.get(key);
    const occupant = byPath.get(overlay.identity.canonicalPath);
    if (occupant && identityKey(occupant.identity) !== key) {
      const distinctAnnotations = occupant.identity.kind === "apple-annotation" && overlay.identity.kind === "apple-annotation";
      // A stable-ID deletion must never delete an unrelated annotation that
      // reused its old path. An explicit prior tombstone also permits reuse.
      if (distinctAnnotations && overlay.operation === "tombstone") {
        if (sameKey) remove(sameKey);
        continue;
      }
      if (occupant.overlay?.recordedAt === overlay.recordedAt) conflict();
      if (distinctAnnotations && occupant.overlay?.operation !== "tombstone") conflict();
      remove(occupant);
    }
    if (sameKey) remove(sameKey);
    const entry: Entry = { identity: overlay.identity, overlay };
    byPath.set(overlay.identity.canonicalPath, entry);
    byKey.set(key, entry);
  }
  const entries = [...byPath.values()];
  return {
    base: entries.flatMap((entry) => entry.base ? [entry.base] : []),
    overlays: entries.flatMap((entry) => entry.overlay?.operation === "upsert" ? [entry.overlay] : []),
  };
}

/** New writes are serialized by IndexStore. Keep cross-key ordering strict even
 * within one clock tick or following a wall-clock correction. */
export function nextOverlayRecordedAt(overlays: readonly OverlayPrefixRecord[]): string {
  return new Date(Math.max(Date.now(), ...overlays.map((entry) => Date.parse(entry.recordedAt) + 1))).toISOString();
}
