const ASCII_ONLY = /^[\x00-\x7f]*$/;

function win32KeyEvent(utf16CodeUnit: number, keyDown: boolean): string {
  return `\x1b[0;0;${utf16CodeUnit};${keyDown ? 1 : 0};0;1_`;
}

// Win32 input mode bypasses console output-code-page loss while preserving the
// same ConPTY transport for UTF-16 input.
export function encodeWindowsPtyInput(data: string): string {
  if (ASCII_ONLY.test(data)) return data;
  let encoded = "";
  for (const character of data) {
    if (character.charCodeAt(0) <= 0x7f) {
      encoded += character;
      continue;
    }
    for (let index = 0; index < character.length; index += 1) {
      const codeUnit = character.charCodeAt(index);
      encoded += win32KeyEvent(codeUnit, true);
      encoded += win32KeyEvent(codeUnit, false);
    }
  }
  return encoded;
}
