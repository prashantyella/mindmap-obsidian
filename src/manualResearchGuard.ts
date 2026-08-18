import { assertSafeNoteArgument } from "./runArguments";

export function isSafeManualResearchPath(notePath: string): boolean {
  try {
    assertSafeNoteArgument(notePath);
    return true;
  } catch {
    return false;
  }
}
