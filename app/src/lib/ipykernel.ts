/**
 * Shared constants and helpers for buffering Jupyter-style IOPub messages in
 * notebook outputs. The frontend treats these as a special output item so we
 * can surface partial (streaming) data while the cell is still running.
 */

export const IOPUB_MIME_TYPE = "application/vnd.jupyter.iopub+json";
export const IOPUB_INCOMPLETE_METADATA_KEY = "aisre.iopub.incomplete";

// IPykernelMessage represents a Jupyter general message
// https://jupyter-protocol.readthedocs.io/en/latest/messaging.html?utm_source=chatgpt.com#general-message-format
export type IPykernelMessage = {
  header?: {
    msg_id?: string;
    username?: string;
    session?: string;
    date?: string;
    msg_type?: string;
    version?: string;
  };
  parent_header?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  content?: {
    data?: Record<string, unknown>;
  } & Record<string, unknown>;
  buffers?: unknown[];
};

/**
 * maybeParseIPykernelMessage attempts to parse a line of stdout as an IOPub message.
 *
 * The ipykernel protocol is defined here:
 * https://jupyter-protocol.readthedocs.io/en/latest/messaging.html?utm_source=chatgpt.com#general-message-format
 * There is a general message format defined at the above link.
 * The header contains the msg_type field; msg_type indicates the type of message.
 * update_display_data messages (https://jupyter-protocol.readthedocs.io/en/latest/messaging.html?utm_source=chatgpt.com#update-display-data)
 * are used to send content to be rendered.
 *
 * The check is intentionally permissive: if the line parses as JSON and
 * resembles an IOPub payload (msg_type in the header),
 * we treat it as an IOPub message so callers can buffer it separately.
 */
export function maybeParseIPykernelMessage(
  line: string,
): IPykernelMessage | null {
  const trimmed = line.trim();
  if (
    trimmed.length === 0 ||
    !trimmed.startsWith("{") ||
    !trimmed.endsWith("}")
  ) {
    return null;
  }

  try {
    // TODO(jlewi): Could this be more efficient? Do we need to try to do JSON parsing here vs. just string checks?
    const parsed = JSON.parse(trimmed) as IPykernelMessage;
    const msgType = parsed.msg_type ?? parsed.header?.msg_type;

    if (typeof msgType === "string") {
      return parsed;
    }
  } catch (error) {
    // Not JSON, fallthrough to null.
  }

  return null;
}
