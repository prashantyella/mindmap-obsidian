import { assertSafeNoteArgument } from "./runArguments";

export function isSafeManualResearchPath(notePath: string, configDir: string): boolean {
  try {
    assertSafeNoteArgument(notePath, configDir);
    return true;
  } catch {
    return false;
  }
}
