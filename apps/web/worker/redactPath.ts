/**
 * Request paths whose segments carry a bearer capability: anyone who reads
 * the path can use it. Each pattern captures the text before the token and
 * the text after it, so a log line keeps the route's shape and drops only
 * the secret.
 */
const CAPABILITY_PATHS: readonly RegExp[] = [
  // Plaintext share links and their assets and sources.
  /^(\/api\/share\/)[^/]+(\/.*)?$/,
  // Encrypted share links and their content blobs.
  /^(\/api\/e2ee\/share\/)[^/]+(\/.*)?$/
];

export const REDACTED_PATH_SEGMENT = ':redacted';

/** A request path safe to write to logs: capability tokens are replaced. */
export function redactPath(pathname: string): string {
  for (const pattern of CAPABILITY_PATHS) {
    const match = pattern.exec(pathname);
    if (match) return `${match[1]}${REDACTED_PATH_SEGMENT}${match[2] ?? ''}`;
  }
  return pathname;
}
