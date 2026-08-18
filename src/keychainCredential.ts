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

function runSecurityCommand(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/security", args, { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error("security failed")));
  });
}
