const ANSI_OSC_PATTERN = /(?:\x1b\][^\x07]*(?:\x07|\x1b\\))/g
const ANSI_CSI_PATTERN = /(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g
const ANSI_CHARSET_PATTERN = /\x1b[()*+\-.\/][0-~]/g
const ANSI_SINGLE_CHAR_PATTERN = /\x1b[@-Z\\-_]/g

/**
 * Removes terminal control sequences from text rendered outside an xterm.
 *
 * Runme stores stdout/stderr bytes exactly as produced by the process so the
 * interactive console can interpret color and cursor controls. Static notebook
 * output uses plain React text nodes, so those same escape bytes need to be
 * removed instead of displayed as `^[[...` glyphs.
 */
export function stripAnsiControlSequences(text: string): string {
  return text
    .replace(ANSI_OSC_PATTERN, '')
    .replace(ANSI_CSI_PATTERN, '')
    .replace(ANSI_CHARSET_PATTERN, '')
    .replace(ANSI_SINGLE_CHAR_PATTERN, '')
}
