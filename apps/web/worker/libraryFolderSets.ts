import { cachedSchemaProbe } from '@openzcad/cloudflare-adapters';

/**
 * The account copy of the library's folders (migration 0045), one record per
 * account. The browser owns the content and the merge
 * (`src/lib/libraryFolderSync.ts`); the Worker stores whichever copy a
 * browser writes against the revision it last read, so two devices writing
 * at once cannot silently overwrite each other: the second is told the
 * current revision, merges, and writes again.
 *
 * Format 1 is the plaintext folder-set JSON. Format 2 is the same set sealed
 * under the account key (ADR-024), opaque here; folder names are the user's
 * own words, so an account whose projects must be encrypted stores only
 * format 2.
 */
export const LIBRARY_FOLDERS_ROUTE = '/api/library-folders';
/** Matches the migration's CHECK; a folder set is far smaller in practice. */
export const MAX_LIBRARY_FOLDER_RECORD_CHARS = 256 * 1024;
export const LIBRARY_FOLDER_FORMATS = [1, 2] as const;
export type LibraryFolderFormat = (typeof LIBRARY_FOLDER_FORMATS)[number];
/** The plaintext record's own schema version (`FOLDER_SET_VERSION`). */
const PLAINTEXT_SET_VERSION = 2;

export interface LibraryFolderSetSnapshot {
  /** 0 while the account has never stored folders. */
  revision: number;
  format: LibraryFolderFormat | null;
  record: string | null;
  updatedAt: string | null;
}

export interface SaveLibraryFolderSetInput {
  expectedRevision: number;
  format: LibraryFolderFormat;
  record: string;
}

export class LibraryFolderRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'LibraryFolderRequestError';
  }
}

export class LibraryFolderRevisionConflictError extends Error {
  constructor(readonly current: LibraryFolderSetSnapshot) {
    super(`Library folders are at revision ${current.revision}.`);
    this.name = 'LibraryFolderRevisionConflictError';
  }
}

/** Whether migration 0045 installed the table and its erasure fence. */
export const isLibraryFolderStorageReady = cachedSchemaProbe(
  `SELECT
     (SELECT COUNT(*) FROM pragma_table_info('library_folder_sets')
      WHERE name IN ('user_id', 'format', 'revision', 'record', 'updated_at'))
       AS columns,
     (SELECT COUNT(*) FROM sqlite_schema
      WHERE type = 'trigger' AND name IN (
        'block_erasing_library_folders_insert',
        'block_erasing_library_folders_update'
      )) AS triggers`,
  (row) => row?.columns === 5 && row.triggers === 2
);

function invalid(message: string): LibraryFolderRequestError {
  return new LibraryFolderRequestError(400, 'LIBRARY_FOLDERS_INVALID', message);
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** Shape checks only: the browser validates content when it reads it back. */
export function parseSaveLibraryFolderSetRequest(
  body: unknown
): SaveLibraryFolderSetInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw invalid('Request body must be a JSON object.');
  }
  const input = body as Record<string, unknown>;
  const { expectedRevision, format, record } = input;
  if (
    typeof expectedRevision !== 'number' ||
    !Number.isInteger(expectedRevision) ||
    expectedRevision < 0
  ) {
    throw invalid('"expectedRevision" must be a non-negative integer.');
  }
  if (format !== 1 && format !== 2) {
    throw invalid('"format" must be 1 or 2.');
  }
  if (typeof record !== 'string' || record.length === 0) {
    throw invalid('"record" must be a non-empty string.');
  }
  if (record.length > MAX_LIBRARY_FOLDER_RECORD_CHARS) {
    throw new LibraryFolderRequestError(
      413,
      'LIBRARY_FOLDERS_TOO_LARGE',
      `Library folders exceed the ${MAX_LIBRARY_FOLDER_RECORD_CHARS}-character cloud limit.`
    );
  }
  if (format === 1) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(record);
    } catch {
      throw invalid('A format 1 record must be JSON.');
    }
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      (parsed as { version?: unknown }).version !== PLAINTEXT_SET_VERSION
    ) {
      throw invalid(
        `A format 1 record must be a version ${PLAINTEXT_SET_VERSION} folder set.`
      );
    }
  } else if (!BASE64URL.test(record)) {
    throw invalid('A format 2 record must be base64url.');
  }
  return { expectedRevision, format, record };
}

interface LibraryFolderRow {
  format: LibraryFolderFormat;
  revision: number;
  record: string;
  updated_at: string;
}

export async function loadLibraryFolderSet(
  db: D1Database,
  userId: string
): Promise<LibraryFolderSetSnapshot> {
  const row = await db
    .prepare(
      `SELECT format, revision, record, updated_at
       FROM library_folder_sets WHERE user_id = ?`
    )
    .bind(userId)
    .first<LibraryFolderRow>();
  return row
    ? {
        revision: row.revision,
        format: row.format,
        record: row.record,
        updatedAt: row.updated_at
      }
    : { revision: 0, format: null, record: null, updatedAt: null };
}

/**
 * Stores the record when the account copy is still at `expectedRevision`
 * (0: none stored yet). Otherwise answers the current copy so the browser
 * can merge it and try again.
 */
export async function saveLibraryFolderSet(
  db: D1Database,
  userId: string,
  input: SaveLibraryFolderSetInput,
  now = new Date().toISOString()
): Promise<LibraryFolderSetSnapshot> {
  const revision = input.expectedRevision + 1;
  const result =
    input.expectedRevision === 0
      ? await db
          .prepare(
            `INSERT INTO library_folder_sets
               (user_id, format, revision, record, updated_at)
             VALUES (?, ?, 1, ?, ?)
             ON CONFLICT(user_id) DO NOTHING`
          )
          .bind(userId, input.format, input.record, now)
          .run()
      : await db
          .prepare(
            `UPDATE library_folder_sets
             SET format = ?, revision = ?, record = ?, updated_at = ?
             WHERE user_id = ? AND revision = ?`
          )
          .bind(
            input.format,
            revision,
            input.record,
            now,
            userId,
            input.expectedRevision
          )
          .run();
  if (result.meta?.changes !== 1) {
    throw new LibraryFolderRevisionConflictError(
      await loadLibraryFolderSet(db, userId)
    );
  }
  return {
    revision,
    format: input.format,
    record: input.record,
    updatedAt: now
  };
}

/** Profile erasure removes the folders with the rest of the profile. */
export async function libraryFolderErasureStatements(
  db: D1Database,
  userId: string
): Promise<D1PreparedStatement[]> {
  if (!(await isLibraryFolderStorageReady(db))) return [];
  return [
    db.prepare('DELETE FROM library_folder_sets WHERE user_id = ?').bind(userId)
  ];
}
