import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { TFile, Vault } from "obsidian";

import type { ResolvedRuntime, RuntimeContext } from "./pathResolver";

const MAX_PENDING_ITEMS = 5;
const DEFAULT_DEBOUNCE_MS = 500;

export interface PendingSummary {
  total: number;
  items: string[];
}

export interface PendingMetrics {
  durationMs: number;
  filesListed: number;
  filesScanned: number;
  filesUpdated: number;
  totalTracked: number;
  dirtyPaths: number;
  stateReloaded: boolean;
  configReloaded: boolean;
}

export interface PendingSnapshot {
  available: boolean;
  reason: string;
  current: PendingSummary;
  all: PendingSummary;
  metrics: PendingMetrics;
  lastUpdatedAt: number | null;
}

interface PendingConfig {
  currentPaths: string[];
  allPaths: string[];
  heading: string;
  minWords: number;
  statePath: string;
}

interface PendingConfigCache {
  mtimeMs: number;
  config: PendingConfig;
}

interface PendingStateCache {
  mtimeMs: number;
  hashes: Record<string, string>;
}

interface PendingEntry {
  relpath: string;
  mtimeMs: number;
  hash: string;
  inCurrent: boolean;
  inAll: boolean;
}

interface PendingFileRecord {
  relpath: string;
  mtimeMs: number;
  read(): Promise<string>;
}

interface PendingRefreshInput {
  config: PendingConfig;
  stateHashes: Record<string, string>;
  files: PendingFileRecord[];
  dirtyPaths: Set<string>;
  forceFull: boolean;
  now: number;
}

interface PendingServiceDeps {
  listMarkdownFiles(): TFile[];
  readVaultFile(file: TFile): Promise<string>;
  readTextFile(targetPath: string): Promise<string>;
  statMtime(targetPath: string): Promise<number | null>;
  log(message: string): void;
  now(): number;
  setTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimer(handle: ReturnType<typeof setTimeout>): void;
  onUpdated?(): void;
}

const defaultFsDeps = {
  readTextFile: async (targetPath: string) => await fs.promises.readFile(targetPath, "utf8"),
  statMtime: async (targetPath: string) => {
    try {
      const stat = await fs.promises.stat(targetPath);
      return stat.mtimeMs;
    } catch {
      return null;
    }
  },
};

function emptySummary(): PendingSummary {
  return { total: 0, items: [] };
}

function emptyMetrics(): PendingMetrics {
  return {
    durationMs: 0,
    filesListed: 0,
    filesScanned: 0,
    filesUpdated: 0,
    totalTracked: 0,
    dirtyPaths: 0,
    stateReloaded: false,
    configReloaded: false,
  };
}

function normalizeFolder(folder: string): string {
  return folder.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

function isWithinScope(relpath: string, folders: string[]): boolean {
  if (folders.length === 0) {
    return false;
  }

  return folders.some((folder) => folder === "." || relpath === folder || relpath.startsWith(`${folder}/`));
}

function stripFrontmatter(text: string): string {
  if (!text.startsWith("---")) {
    return text;
  }

  const lines = text.split(/\r?\n/);
  let end = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === "---") {
      end = index;
      break;
    }
  }

  return end === -1 ? text : lines.slice(end + 1).join("\n");
}

function stripRelatedSection(text: string, heading: string): string {
  let lines = text.split(/\r?\n/);
  const headingLine = (heading || "## Mindmap").trim().toLowerCase();
  const legacyHeadings = new Set([headingLine, "## related", "## mindmap"]);

  lines = lines.filter((line) => !line.toLowerCase().includes("mindmap:start") && !line.toLowerCase().includes("mindmap:end"));

  const withoutHeadings: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (legacyHeadings.has(lines[index].trim().toLowerCase())) {
      index += 1;
      while (index < lines.length && !lines[index].startsWith("#")) {
        index += 1;
      }
      index -= 1;
      continue;
    }
    withoutHeadings.push(lines[index]);
  }

  const cleaned: string[] = [];
  for (let index = 0; index < withoutHeadings.length; index += 1) {
    const trimmed = withoutHeadings[index].trim();
    if (/^>\s*\[!.*\]-\s*(mindmap|related)\s*$/i.test(trimmed)) {
      index += 1;
      while (index < withoutHeadings.length && withoutHeadings[index].startsWith(">")) {
        index += 1;
      }
      index -= 1;
      continue;
    }
    cleaned.push(withoutHeadings[index]);
  }

  return `${cleaned.join("\n").trim()}\n`;
}

function computeBodyHash(text: string, heading: string): { hash: string | null; wordCount: number } {
  const body = stripRelatedSection(stripFrontmatter(text), heading);
  const wordCount = body.split(/\s+/).filter(Boolean).length;
  if (wordCount === 0) {
    return { hash: null, wordCount };
  }

  return {
    hash: createHash("sha1").update(body).digest("hex"),
    wordCount,
  };
}

function buildStateHashes(rawState: unknown): Record<string, string> {
  if (!rawState || typeof rawState !== "object") {
    return {};
  }

  const files = (rawState as { files?: Record<string, { hash?: string }> }).files ?? {};
  const hashes: Record<string, string> = {};
  for (const [relpath, value] of Object.entries(files)) {
    if (value && typeof value.hash === "string") {
      hashes[relpath.replace(/\\/g, "/")] = value.hash;
    }
  }
  return hashes;
}

function parsePendingConfig(rawConfig: unknown, runtimeConfigPath: string, context: RuntimeContext): PendingConfig {
  const config = rawConfig && typeof rawConfig === "object" ? rawConfig as Record<string, unknown> : {};
  const currentPaths = Array.isArray(config.notes_paths_current)
    ? config.notes_paths_current.map((value) => normalizeFolder(String(value))).filter(Boolean)
    : Array.isArray(config.notes_paths)
      ? config.notes_paths.map((value) => normalizeFolder(String(value))).filter(Boolean)
      : [];
  const allPaths = Array.isArray(config.notes_paths_all)
    ? config.notes_paths_all.map((value) => normalizeFolder(String(value))).filter(Boolean)
    : currentPaths;

  const statePathValue = typeof config.state_path === "string" ? config.state_path : ".obsidian/plugins/mindmap-obsidian/data/state.json";
  const statePath = path.isAbsolute(statePathValue)
    ? statePathValue
    : path.resolve(context.vaultRoot, statePathValue);

  return {
    currentPaths,
    allPaths: allPaths.length > 0 ? allPaths : currentPaths,
    heading: typeof config.mindmap_heading === "string"
      ? config.mindmap_heading
      : typeof config.related_heading === "string"
        ? config.related_heading
        : "## Mindmap",
    minWords: Number(config.min_note_words ?? 0) || 0,
    statePath: path.resolve(path.dirname(runtimeConfigPath), path.relative(path.dirname(runtimeConfigPath), statePath)),
  };
}

export class PendingIndex {
  private readonly entries = new Map<string, PendingEntry>();

  async refresh(input: PendingRefreshInput): Promise<PendingSnapshot> {
    const start = input.now;
    const fileMap = new Map(input.files.map((file) => [file.relpath, file]));
    const metrics = emptyMetrics();
    metrics.filesListed = input.files.length;
    metrics.dirtyPaths = input.dirtyPaths.size;

    for (const relpath of [...this.entries.keys()]) {
      if (!fileMap.has(relpath)) {
        this.entries.delete(relpath);
      }
    }

    for (const file of input.files) {
      const inCurrent = isWithinScope(file.relpath, input.config.currentPaths);
      const inAll = isWithinScope(file.relpath, input.config.allPaths);
      if (!inCurrent && !inAll) {
        this.entries.delete(file.relpath);
        continue;
      }

      const cached = this.entries.get(file.relpath);
      const shouldScan = input.forceFull
        || !cached
        || cached.mtimeMs !== file.mtimeMs
        || cached.inCurrent !== inCurrent
        || cached.inAll !== inAll
        || input.dirtyPaths.has(file.relpath);

      if (!shouldScan && cached) {
        cached.inCurrent = inCurrent;
        cached.inAll = inAll;
        continue;
      }

      metrics.filesScanned += 1;
      const text = await file.read();
      const body = computeBodyHash(text, input.config.heading);
      if (input.config.minWords > 0 && body.wordCount < input.config.minWords) {
        this.entries.delete(file.relpath);
        continue;
      }
      if (!body.hash) {
        this.entries.delete(file.relpath);
        continue;
      }

      const nextEntry: PendingEntry = {
        relpath: file.relpath,
        mtimeMs: file.mtimeMs,
        hash: body.hash,
        inCurrent,
        inAll,
      };
      this.entries.set(file.relpath, nextEntry);
      metrics.filesUpdated += 1;
    }

    metrics.totalTracked = this.entries.size;
    const currentItems: PendingEntry[] = [];
    const allItems: PendingEntry[] = [];
    for (const entry of this.entries.values()) {
      const pending = input.stateHashes[entry.relpath] !== entry.hash;
      if (!pending) {
        continue;
      }
      if (entry.inCurrent) {
        currentItems.push(entry);
      }
      if (entry.inAll) {
        allItems.push(entry);
      }
    }

    const byRecent = (left: PendingEntry, right: PendingEntry) => right.mtimeMs - left.mtimeMs;
    currentItems.sort(byRecent);
    allItems.sort(byRecent);

    const end = Date.now();
    metrics.durationMs = end - start;

    return {
      available: true,
      reason: "Pending scan ready.",
      current: {
        total: currentItems.length,
        items: currentItems.slice(0, MAX_PENDING_ITEMS).map((entry) => entry.relpath),
      },
      all: {
        total: allItems.length,
        items: allItems.slice(0, MAX_PENDING_ITEMS).map((entry) => entry.relpath),
      },
      metrics,
      lastUpdatedAt: end,
    };
  }
}

export class DebouncedRefreshController {
  private handle: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly setTimer: PendingServiceDeps["setTimer"],
    private readonly clearTimer: PendingServiceDeps["clearTimer"],
    private readonly callback: () => void,
    private readonly delayMs = DEFAULT_DEBOUNCE_MS,
  ) { }

  trigger(): void {
    if (this.handle) {
      this.clearTimer(this.handle);
    }
    this.handle = this.setTimer(() => {
      this.handle = null;
      this.callback();
    }, this.delayMs);
  }

  dispose(): void {
    if (this.handle) {
      this.clearTimer(this.handle);
      this.handle = null;
    }
  }
}

export class PendingScanService {
  private readonly index = new PendingIndex();
  private readonly dirtyPaths = new Set<string>();
  private readonly debouncer: DebouncedRefreshController;
  private snapshot: PendingSnapshot = {
    available: false,
    reason: "Pending scan has not started yet.",
    current: emptySummary(),
    all: emptySummary(),
    metrics: emptyMetrics(),
    lastUpdatedAt: null,
  };
  private configCache: PendingConfigCache | null = null;
  private stateCache: PendingStateCache | null = null;
  private refreshInFlight: Promise<void> | null = null;
  private queuedRefresh = false;

  constructor(
    private readonly context: RuntimeContext,
    private readonly getRuntime: () => ResolvedRuntime,
    private readonly deps: PendingServiceDeps,
  ) {
    this.debouncer = new DebouncedRefreshController(
      deps.setTimer,
      deps.clearTimer,
      () => {
        void this.refresh();
      },
    );
  }

  async warm(): Promise<void> {
    await this.refresh(true);
  }

  requestRefresh(reason: string, relpaths: string[] = []): void {
    for (const relpath of relpaths) {
      this.dirtyPaths.add(relpath.replace(/\\/g, "/"));
    }
    this.deps.log(`Pending refresh requested: ${reason}${relpaths.length ? ` (${relpaths.join(", ")})` : ""}`);
    this.debouncer.trigger();
  }

  getSnapshot(): PendingSnapshot {
    return this.snapshot;
  }

  dispose(): void {
    this.debouncer.dispose();
  }

  private async refresh(forceFull = false): Promise<void> {
    if (this.refreshInFlight) {
      this.queuedRefresh = true;
      return this.refreshInFlight;
    }

    this.refreshInFlight = this.runRefresh(forceFull);
    try {
      await this.refreshInFlight;
    } finally {
      this.refreshInFlight = null;
      if (this.queuedRefresh) {
        this.queuedRefresh = false;
        await this.refresh();
      }
    }
  }

  private async runRefresh(forceFull: boolean): Promise<void> {
    try {
      const runtime = this.getRuntime();
      if (!runtime.valid) {
        this.snapshot = {
          available: false,
          reason: runtime.messages.find((message) => message.level === "error")?.message ?? "Runtime is not ready.",
          current: emptySummary(),
          all: emptySummary(),
          metrics: emptyMetrics(),
          lastUpdatedAt: Date.now(),
        };
        this.deps.onUpdated?.();
        return;
      }

      const configInfo = await this.loadConfig(runtime.configPath);
      if (!configInfo) {
        this.snapshot = {
          available: false,
          reason: "Pending scan config could not be loaded.",
          current: emptySummary(),
          all: emptySummary(),
          metrics: emptyMetrics(),
          lastUpdatedAt: Date.now(),
        };
        this.deps.onUpdated?.();
        return;
      }

      const stateInfo = await this.loadState(configInfo.config.statePath);
      const files = this.deps.listMarkdownFiles().map((file) => ({
        relpath: file.path,
        mtimeMs: file.stat.mtime,
        read: async () => await this.deps.readVaultFile(file),
      }));

      const dirtyPaths = new Set(this.dirtyPaths);
      this.dirtyPaths.clear();
      const snapshot = await this.index.refresh({
        config: configInfo.config,
        stateHashes: stateInfo?.hashes ?? {},
        files,
        dirtyPaths,
        forceFull: forceFull || configInfo.reloaded,
        now: this.deps.now(),
      });

      snapshot.metrics.configReloaded = configInfo.reloaded;
      snapshot.metrics.stateReloaded = stateInfo?.reloaded ?? false;
      this.snapshot = snapshot;
      this.deps.onUpdated?.();
      this.deps.log(
        `Pending scan updated in ${snapshot.metrics.durationMs}ms (listed ${snapshot.metrics.filesListed}, scanned ${snapshot.metrics.filesScanned}, updated ${snapshot.metrics.filesUpdated}, tracked ${snapshot.metrics.totalTracked}).`,
      );
    } catch (error) {
      this.snapshot = {
        available: false,
        reason: error instanceof Error ? error.message : "Pending scan failed.",
        current: emptySummary(),
        all: emptySummary(),
        metrics: emptyMetrics(),
        lastUpdatedAt: Date.now(),
      };
      this.deps.onUpdated?.();
      this.deps.log(`Pending scan failed: ${this.snapshot.reason}`);
    }
  }

  private async loadConfig(configPath: string): Promise<{ config: PendingConfig; reloaded: boolean } | null> {
    const mtimeMs = await this.deps.statMtime(configPath);
    if (mtimeMs === null) {
      this.configCache = null;
      return null;
    }

    if (this.configCache && this.configCache.mtimeMs === mtimeMs) {
      return { config: this.configCache.config, reloaded: false };
    }

    const rawConfig = JSON.parse(await this.deps.readTextFile(configPath));
    const config = parsePendingConfig(rawConfig, configPath, this.context);
    this.configCache = { mtimeMs, config };
    return { config, reloaded: true };
  }

  private async loadState(statePath: string): Promise<{ hashes: Record<string, string>; reloaded: boolean } | null> {
    const mtimeMs = await this.deps.statMtime(statePath);
    if (mtimeMs === null) {
      this.stateCache = null;
      return { hashes: {}, reloaded: false };
    }

    if (this.stateCache && this.stateCache.mtimeMs === mtimeMs) {
      return { hashes: this.stateCache.hashes, reloaded: false };
    }

    let rawState: unknown;
    try {
      rawState = JSON.parse(await this.deps.readTextFile(statePath));
    } catch {
      this.stateCache = null;
      return { hashes: {}, reloaded: true };
    }
    const hashes = buildStateHashes(rawState);
    this.stateCache = { mtimeMs, hashes };
    return { hashes, reloaded: true };
  }
}

export function createPendingScanService(
  vault: Vault,
  context: RuntimeContext,
  getRuntime: () => ResolvedRuntime,
  log: (message: string) => void,
  onUpdated?: () => void,
): PendingScanService {
  return new PendingScanService(context, getRuntime, {
    listMarkdownFiles: () => vault.getMarkdownFiles(),
    readVaultFile: async (file) => await vault.cachedRead(file),
    readTextFile: defaultFsDeps.readTextFile,
    statMtime: defaultFsDeps.statMtime,
    log,
    now: () => Date.now(),
    setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer: (handle) => clearTimeout(handle),
    onUpdated,
  });
}
