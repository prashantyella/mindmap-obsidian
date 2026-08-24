import { AtomicStore, type AtomicStoreFs } from "../engine/atomicStore";
import { EngineError } from "../engine/errors";
import { buildMigrationRecordV1, parseMigrationRecordV1, toPublicMigrationStatus, type BuildMigrationRecordExtra, type MigrationRecordV1 } from "./migrationRecord";
import type { MigrationMessageCode, MigrationPhase, MigrationStatusV1 } from "./migrationContract";

const MIGRATION_STORE_FILE_NAME = "migration/state.json";
const MIGRATION_STORE_SCHEMA_VERSION = 1;
/** A `MigrationRecordV1` is a handful of bounded scalars (counts, ids, hex-64 fingerprints, a small number of short tokens) -- never a per-note collection and never note bodies/vectors. Generous but still fixed headroom, mirrors every other store's own `maxBytes` cap. */
const MAX_MIGRATION_STORE_BYTES = 256 * 1024;

/**
 * Item 1: every `MigrationStore` instance constructed over the SAME
 * resolved root SHARES ONE IN-PROCESS mutation tail -- not one per
 * instance, and not a cross-process lock of any kind (this is a plain
 * in-memory `Map`, invisible to any other OS process). Two separate
 * `MigrationStore` instances over the same data root WITHIN THIS SAME
 * PROCESS (e.g. a restarted `ProductionEngine`'s new instance racing a
 * not-yet-disposed prior one during a hot-reload) serialize their
 * `mutate()` calls against each other through this tail; a per-instance-
 * only tail could not do that. `MigrationRunner` additionally serializes
 * its OWN reconcile/start/cancel effect lanes per data root
 * (`migrationRunner.ts`'s `withRootLock`) -- also in-process only. Neither
 * mechanism protects against a genuinely separate OS process (e.g. two
 * Obsidian windows) writing the same data root concurrently; see
 * `setPhase`'s own doc comment for what the `expectedRevision`
 * compare-and-set can and cannot do about that.
 */
const sharedRootTails = new Map<string, Promise<void>>();

function tailKey(root: string): string {
  return root;
}

/**
 * Checkpoint 10A: the ONE durable, atomic, versioned persistence layer for
 * migration progress -- `migration/state.json`, written through the same
 * `AtomicStore` primitive (temp-file + rename, strict schema-versioned
 * parse-on-load, bounded size) every other Checkpoint 5/7/8 store already
 * uses. Never reads, parses, mutates, or deletes anything under Chroma's
 * own directory -- this store touches exactly one file, inside the
 * plugin-owned data root it is constructed against.
 *
 * Persists the full internal `MigrationRecordV1` (item 1) -- run
 * ownership, drift-detection snapshot, and cancellation-intent fields
 * that must never leak to a UI-facing status. `getPublicStatus()` is the
 * ONE path that projects it down to the redacted `MigrationStatusV1` a
 * caller/UI is allowed to observe.
 */
export class MigrationStore {
  private readonly store: AtomicStore<MigrationRecordV1>;
  private readonly tailKey: string;

  constructor(fs: AtomicStoreFs, root: string) {
    this.store = new AtomicStore<MigrationRecordV1>({
      fs,
      root,
      fileName: MIGRATION_STORE_FILE_NAME,
      schemaVersion: MIGRATION_STORE_SCHEMA_VERSION,
      parse: parseMigrationRecordV1,
      maxBytes: MAX_MIGRATION_STORE_BYTES,
    });
    this.tailKey = tailKey(root);
    if (!sharedRootTails.has(this.tailKey)) {
      sharedRootTails.set(this.tailKey, Promise.resolve());
    }
  }

  /** `null` when no migration has ever been persisted for this data root (a fresh install, or a pre-migration checkout). Never fabricates a `"not-started"` record itself -- that is the caller's (`MigrationRunner`'s) job on a genuine `null`. */
  load(): Promise<MigrationRecordV1 | null> {
    return this.store.load();
  }

  /** Convenience: `load()` projected through `toPublicMigrationStatus`, `null` preserved as-is. */
  async getPublicStatus(): Promise<MigrationStatusV1 | null> {
    const record = await this.load();
    return record ? toPublicMigrationStatus(record) : null;
  }

  /** Best-effort cleanup of a prior interrupted `save()`'s leftover temp file. Safe to call any number of times, mirrors every other store's own `cleanupStaleTempFiles`. */
  cleanupStaleTempFiles(): Promise<number> {
    return this.store.cleanupStaleTempFiles();
  }

  /**
   * Serializes `updater` (given the current persisted record, or `null`
   * for a fresh install) behind the SHARED root-keyed mutation tail, and
   * atomically persists whatever `updater` returns. `updater` must be
   * side-effect-free besides its return value -- exactly the same
   * "operates on a value, never on shared mutable state" discipline
   * `JobStore.updateJob`'s own updater contract already requires.
   */
  mutate(updater: (current: MigrationRecordV1 | null) => MigrationRecordV1): Promise<MigrationRecordV1> {
    const previousTail = sharedRootTails.get(this.tailKey) ?? Promise.resolve();
    const run = previousTail.then(async () => {
      const current = await this.store.load();
      const next = updater(current);
      await this.store.save(next);
      return next;
    });
    sharedRootTails.set(
      this.tailKey,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  /**
   * Convenience: builds a fresh record from `phase`/`messageCode`/counts
   * via `buildMigrationRecordV1` and persists it through `mutate()` -- the
   * one path every `MigrationRunner` phase transition writes through.
   *
   * Review item 8/12: when `expectedRevision` is supplied, this is an
   * OPTIMISTIC compare-and-set -- if the record actually on disk at write
   * time has a DIFFERENT `revision` than `expectedRevision`, this throws
   * `MIGRATION_REVISION_CONFLICT` and persists NOTHING; the caller
   * (`MigrationRunner.persist()`) treats that as "yield to whatever the
   * other writer committed" rather than blindly overwriting it. This is a
   * read-then-compare check on the record's OWN content, not a lock: it
   * detects a conflict only if the two writes are actually SERIALIZED
   * (one genuinely commits, and is genuinely read back, before the other's
   * write lands) -- it cannot prevent two writers from concurrently
   * reading the SAME prior revision and both proceeding, the way a true
   * mutual-exclusion lock would. Within this process, `mutate()`'s shared
   * tail already serializes every write, so this check mostly only ever
   * fires there as an extra safety net; it is the ONLY defense at all
   * against a genuinely separate OS process writing the same data root,
   * and it is honest about not being a complete one -- see
   * `sharedRootTails`'s own doc comment above. The persisted revision
   * itself always advances by exactly 1 from whatever revision it is
   * replacing (0 for a fresh record).
   */
  setPhase(phase: MigrationPhase, messageCode: MigrationMessageCode, counts: { discoveredCount: number; processedCount: number; failedCount: number }, nowIso: string, extra?: BuildMigrationRecordExtra, expectedRevision?: number): Promise<MigrationRecordV1> {
    return this.mutate((current) => {
      if (expectedRevision !== undefined && (current?.revision ?? 0) !== expectedRevision) {
        throw new EngineError("MIGRATION_REVISION_CONFLICT", "Migration record was concurrently modified by another writer.");
      }
      const revision = (current?.revision ?? 0) + 1;
      return buildMigrationRecordV1(phase, messageCode, counts, nowIso, { ...extra, revision });
    });
  }
}
