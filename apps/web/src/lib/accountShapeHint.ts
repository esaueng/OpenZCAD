/**
 * The shape the account had the last time this device knew it, so Settings
 * can draw that shape while a reload restores the saved session instead of
 * guessing "signed out" and then rearranging itself once the server answers.
 *
 * Two booleans and nothing else: no user id, name, email, tier or figures.
 * It only ever chooses which placeholders to draw; every real value still
 * waits for the server, and a stale hint is corrected by the first answer.
 */
export const ACCOUNT_SHAPE_HINT_STORAGE_KEY = 'openzcad-account-shape:v1';

export interface AccountShapeHint {
  /** The last resolved session on this device was signed in. */
  signedIn: boolean;
  /** That account had the Encryption section opened to it. */
  encryption: boolean;
}

const SIGNED_OUT: AccountShapeHint = { signedIn: false, encryption: false };

export function normalizeAccountShapeHint(value: unknown): AccountShapeHint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...SIGNED_OUT };
  }
  const root = value as Record<string, unknown>;
  const signedIn = root.signedIn === true;
  return { signedIn, encryption: signedIn && root.encryption === true };
}

export function loadAccountShapeHint(): AccountShapeHint {
  try {
    const raw = window.localStorage.getItem(ACCOUNT_SHAPE_HINT_STORAGE_KEY);
    return raw
      ? normalizeAccountShapeHint(JSON.parse(raw) as unknown)
      : { ...SIGNED_OUT };
  } catch {
    return { ...SIGNED_OUT };
  }
}

/** Merges what is now known into the stored hint; storage failures are moot. */
export function rememberAccountShape(next: Partial<AccountShapeHint>): void {
  const merged = normalizeAccountShapeHint({
    ...loadAccountShapeHint(),
    ...next
  });
  try {
    window.localStorage.setItem(
      ACCOUNT_SHAPE_HINT_STORAGE_KEY,
      JSON.stringify(merged)
    );
  } catch {
    // Private mode or a full quota: the next reload just draws less.
  }
}
