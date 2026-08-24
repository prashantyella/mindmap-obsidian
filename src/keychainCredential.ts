import { spawn } from "node:child_process";

import { WebResearchError } from "./webResearchTypes";

export const EXA_KEYCHAIN_SERVICE = "com.mindmap-ai.web-research";
export const EXA_KEYCHAIN_ACCOUNT = "exa-api-key";

export interface CredentialOptions {
  allowDevelopmentOverride: boolean;
  environment?: Record<string, string | undefined>;
  runSecurity?: (args: string[]) => Promise<string>;
}

export async function getExaCredential(options: CredentialOptions): Promise<string> {
  if (options.allowDevelopmentOverride) {
    const override = options.environment?.MINDMAP_EXA_API_KEY;
    if (override?.trim()) return override.trim();
  }
  const runSecurity = options.runSecurity ?? runSecurityCommand;
  try {
    const key = (await runSecurity(["find-generic-password", "-s", EXA_KEYCHAIN_SERVICE, "-a", EXA_KEYCHAIN_ACCOUNT, "-w"])).trim();
    if (!key) throw new Error("empty credential");
    return key;
  } catch {
    throw new WebResearchError("CREDENTIAL_UNAVAILABLE", "Web Research credential is unavailable in macOS Keychain.");
  }
}

/**
 * Boolean-ONLY macOS Keychain existence check -- deliberately does NOT use
 * `-w` (the flag that would print the credential's value), so the
 * credential's value is never read into this process at all. Never calls
 * Exa itself. Resolves `false` (never throws) on any spawn/exit failure,
 * including on a non-macOS platform where `/usr/bin/security` does not
 * exist. Mirrors the identical, already-reviewed pattern in
 * `engine/devShadowIntegration.ts`'s own (module-private) credential check.
 */
export function hasExaCredential(signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let child: ReturnType<typeof spawn>;
    const settle = (value: boolean) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onAbort = () => {
      child?.kill();
      settle(false);
    };
    try {
      child = spawn("/usr/bin/security", ["find-generic-password", "-s", EXA_KEYCHAIN_SERVICE, "-a", EXA_KEYCHAIN_ACCOUNT], { stdio: "ignore" });
    } catch {
      settle(false);
      return;
    }
    if (signal?.aborted) {
      child.kill();
      settle(false);
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", () => settle(false));
    child.on("close", (code) => settle(code === 0));
  });
}

function runSecurityCommand(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/security", args, { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.on("data", (chunk: unknown) => { stdout += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error("security failed")));
  });
}
