import test from "node:test";
import assert from "node:assert/strict";

import { isOwnedLegacyPythonLaunchAgent, normalizeHour, normalizeMinute, retireLegacyPythonLaunchAgents, shouldOfferLaunchAgentCatchUp } from "./launchAgent";

const PLUGIN_DIR = "/Users/test/Vault/.obsidian/plugins/mindmap-ai";

function ownedLegacyPlist(label: string): string {
  return `<plist><dict>
\t<key>Label</key>
\t<string>${label}</string>
\t<array>
\t\t<string>${PLUGIN_DIR}/python/mindmap.py</string>
\t\t<string>--config</string>
\t\t<string>${PLUGIN_DIR}/python/config.json</string>
\t</array>
\t<string>obsidian-plugin-launchagent</string>
</dict></plist>`;
}

void test("normalizes launch agent clock values", () => {
  assert.equal(normalizeHour(99), 23);
  assert.equal(normalizeHour(-1), 0);
  assert.equal(normalizeHour(Number.NaN), 0);
  assert.equal(normalizeMinute(99), 59);
  assert.equal(normalizeMinute(-1), 0);
  assert.equal(normalizeMinute(Number.NaN), 0);
});

void test("offers catch-up only for overdue or failing agents with pending all-scope notes", () => {
  assert.equal(shouldOfferLaunchAgentCatchUp("overdue", 1), true);
  assert.equal(shouldOfferLaunchAgentCatchUp("failing", 2), true);
  assert.equal(shouldOfferLaunchAgentCatchUp("healthy", 2), false);
  assert.equal(shouldOfferLaunchAgentCatchUp("overdue", 0), false);
  assert.equal(shouldOfferLaunchAgentCatchUp(null, 2), false);
});

void test("legacy LaunchAgent ownership requires the exact label and this plugin directory", () => {
  const plist = ownedLegacyPlist("com.mindmap.daily");
  assert.equal(isOwnedLegacyPythonLaunchAgent(plist, "com.mindmap.daily", PLUGIN_DIR), true);
  assert.equal(isOwnedLegacyPythonLaunchAgent(plist, "com.mindmap.weekly", PLUGIN_DIR), false);
  assert.equal(isOwnedLegacyPythonLaunchAgent(plist, "com.mindmap.daily", "/Users/test/Other"), false);
});

void test("retires loaded owned legacy agents, while leaving foreign agents untouched", async () => {
  const launchAgentsDir = "/Users/test/Library/LaunchAgents";
  const dailyPath = `${launchAgentsDir}/com.mindmap.daily.plist`;
  const weeklyPath = `${launchAgentsDir}/com.mindmap.weekly.plist`;
  const files = new Map<string, string>([
    [dailyPath, ownedLegacyPlist("com.mindmap.daily")],
    [weeklyPath, ownedLegacyPlist("com.other.owner")],
  ]);
  const processCalls: string[][] = [];
  const renameCalls: string[][] = [];
  const results = await retireLegacyPythonLaunchAgents({
    fs: {
      exists: async (filePath) => files.has(filePath),
      readBoundedWithIdentity: async (filePath, maxBytes) => {
        const value = files.get(filePath);
        if (value === undefined || Buffer.byteLength(value, "utf8") > maxBytes) return null;
        return { contents: value, identity: value };
      },
      matchesIdentity: async (filePath, identity) => files.get(filePath) === identity,
      rename: async (fromPath, toPath) => {
        renameCalls.push([fromPath, toPath]);
        const value = files.get(fromPath);
        if (value === undefined) throw new Error("missing");
        files.delete(fromPath);
        files.set(toPath, value);
      },
    },
    runner: {
      run: async (_executablePath, argv) => {
        processCalls.push([...argv]);
        if (argv[0] === "print") return { code: 0, stdout: "state = exited\n", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    },
    userHomeDir: "/Users/test",
    pluginDir: PLUGIN_DIR,
    uid: 501,
    platform: "darwin",
  });

  assert.deepEqual(results, [
    { label: "com.mindmap.daily", status: "retired" },
    { label: "com.mindmap.weekly", status: "foreign" },
  ]);
  assert.deepEqual(processCalls, [
    ["print", "gui/501/com.mindmap.daily"],
    ["bootout", "gui/501/com.mindmap.daily"],
  ]);
  assert.deepEqual(renameCalls, [[dailyPath, `${dailyPath}.retired-0.2.0`]]);
  assert.equal(files.has(weeklyPath), true);
});

void test("a plist swapped after ownership validation is neither unloaded nor archived", async () => {
  const dailyPath = "/Users/test/Library/LaunchAgents/com.mindmap.daily.plist";
  const files = new Map([[dailyPath, ownedLegacyPlist("com.mindmap.daily")]]);
  const processCalls: string[][] = [];
  const renameCalls: string[][] = [];
  const results = await retireLegacyPythonLaunchAgents({
    fs: {
      exists: async (filePath) => files.has(filePath),
      readBoundedWithIdentity: async (filePath) => {
        const contents = files.get(filePath);
        return contents === undefined ? null : { contents, identity: contents };
      },
      matchesIdentity: async (filePath, identity) => files.get(filePath) === identity,
      rename: async (fromPath, toPath) => { renameCalls.push([fromPath, toPath]); },
    },
    runner: {
      run: async (_executablePath, argv) => {
        processCalls.push([...argv]);
        if (argv[0] === "print") {
          files.set(dailyPath, "<plist>foreign replacement</plist>");
          return { code: 0, stdout: "state = waiting\n", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    },
    userHomeDir: "/Users/test",
    pluginDir: PLUGIN_DIR,
    uid: 501,
    platform: "darwin",
  });

  assert.deepEqual(results[0], { label: "com.mindmap.daily", status: "ambiguous" });
  assert.deepEqual(processCalls, [["print", "gui/501/com.mindmap.daily"]]);
  assert.deepEqual(renameCalls, []);
  assert.equal(files.get(dailyPath), "<plist>foreign replacement</plist>");
});
