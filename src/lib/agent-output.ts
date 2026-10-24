/**
 * Shared sanitizers for agent output, worker IPC payloads, and smoke reports.
 * Kept in src/lib so the server, the worker, and developer scripts apply the
 * same bounded redaction rules.
 */

/**
 * Removes a known secret and any key-shaped text from a message before it is
 * logged, sent over IPC, or persisted.
 */
export function redactText(text: string, secret?: string | null): string {
  let redacted = text;
  if (secret) redacted = redacted.split(secret).join("[redacted]");
  return redacted.replace(/sk-or-v1-[A-Za-z0-9_-]+/g, "[redacted]");
}

/**
 * Event-based evidence only: an image content part in a tool result. Token
 * counts or a correct DOM answer never prove screenshot input.
 */
export function containsImageContent(value: unknown, depth = 0): boolean {
  if (depth > 6 || value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) {
    return value.some((item) => containsImageContent(item, depth + 1));
  }
  const record = value as Record<string, unknown>;
  if (record.type === "image") return true;
  if (Array.isArray(record.content)) {
    return containsImageContent(record.content, depth + 1);
  }
  return false;
}
