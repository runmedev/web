import { MimeType, parser_pb } from "../../runme/client";

const OUTPUT_VISIBILITY_IGNORE_MIMES = new Set<string>([
  MimeType.StatefulRunmeTerminal,
]);

/**
 * Determine whether a cell has user-visible output bytes.
 *
 * Cells may contain a placeholder terminal output item that allocates renderer
 * state with an empty buffer. That placeholder should not force the output
 * panel to render for idle cells.
 */
export function hasVisibleCellOutput(
  outputs: parser_pb.CellOutput[] | undefined,
): boolean {
  if (!outputs || outputs.length === 0) {
    return false;
  }

  return outputs.some((output) =>
    (output.items ?? []).some((item) => {
      if (!item || OUTPUT_VISIBILITY_IGNORE_MIMES.has(item.mime || "")) {
        return false;
      }
      const data = item.data as Uint8Array | undefined;
      return Boolean(data && data.length > 0);
    }),
  );
}
