/**
 * Codepoint-based control/NUL character check. Deliberately never a regex
 * literal that embeds a raw control byte in the source file itself -- a
 * byte-level source audit cannot distinguish an intentional control-byte
 * regex from an accidentally leaked stray control byte, so this helper
 * avoids the ambiguity entirely by comparing numeric character codes
 * instead. Matches the same range `canonicalizePath` in `contracts.ts`
 * rejects: the C0 control range and the DEL character.
 */
export function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const isC0Control = code >= 0 && code <= 31;
    const isDelete = code === 127;
    if (isC0Control || isDelete) {
      return true;
    }
  }
  return false;
}
