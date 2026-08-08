/**
 * Schema objects installed by 0010_document_storage_accounting.sql.
 *
 * The readiness probe checks the schema itself instead of trusting deployment
 * order. A migration ledger can say that a file ran while a database restored
 * from another source still lacks the objects the Worker is about to use.
 */
interface DocumentStorageAccountingSchema {
  projects_document_bytes: number;
  revisions_document_bytes: number;
  revisions_bytes_index: number;
}

interface ProjectObjectStorageSchema {
  project_columns: number;
  revision_pointer: number;
  document_objects_table: number;
  storage_assets_table: number;
  document_objects_index: number;
  storage_assets_index: number;
  pointer_indexes: number;
}

interface DesktopAuthSchema {
  tables: number;
  indexes: number;
  user_code_hash: number;
}

interface AccountErasureSchema {
  table_ready: number;
  trigger_count: number;
}

/** Whether migration 0014 installed the erasure fence and every write guard. */
export async function isAccountErasureReady(
  db: D1Database | undefined
): Promise<boolean> {
  if (!db) {
    return false;
  }
  try {
    const schema = await db
      .prepare(
        `SELECT
          EXISTS (
            SELECT 1 FROM sqlite_schema
            WHERE type = 'table' AND name = 'account_erasure_requests'
          ) AS table_ready,
          (
            SELECT COUNT(*) FROM sqlite_schema
            WHERE type = 'trigger' AND name LIKE 'block_erasing_%'
          ) AS trigger_count`
      )
      .first<AccountErasureSchema>();
    return schema?.table_ready === 1 && schema.trigger_count === 23;
  } catch {
    return false;
  }
}

/** Whether migration 0012 installed every native-auth table and lookup index. */
export async function isDesktopAuthReady(
  db: D1Database | undefined
): Promise<boolean> {
  if (!db) {
    return false;
  }

  try {
    const schema = await db
      .prepare(
        `SELECT
          (
            SELECT COUNT(*) FROM sqlite_schema
            WHERE type = 'table' AND name IN (
              'desktop_auth_attempts',
              'desktop_refresh_tokens',
              'desktop_access_tokens'
            )
          ) AS tables,
          (
            SELECT COUNT(*) FROM sqlite_schema
            WHERE type = 'index' AND name IN (
              'idx_desktop_auth_attempts_expires',
              'idx_desktop_refresh_tokens_session',
              'idx_desktop_refresh_tokens_user',
              'idx_desktop_refresh_tokens_expires',
              'idx_desktop_access_tokens_session',
              'idx_desktop_access_tokens_expires'
            )
          ) AS indexes,
          EXISTS (
            SELECT 1 FROM pragma_table_info('desktop_auth_attempts')
            WHERE name = 'user_code_hash'
          ) AS user_code_hash`
      )
      .first<DesktopAuthSchema>();
    return (
      schema?.tables === 3 &&
      schema.indexes === 6 &&
      schema.user_code_hash === 1
    );
  } catch {
    return false;
  }
}

/**
 * Whether D1 can satisfy every storage-accounting query added by migration
 * 0010. Missing bindings and query failures deliberately return false: a
 * rollout gate must never become enabled because readiness was indeterminate.
 */
export async function isDocumentStorageAccountingReady(
  db: D1Database | undefined
): Promise<boolean> {
  if (!db) {
    return false;
  }

  try {
    const schema = await db
      .prepare(
        `SELECT
          EXISTS (
            SELECT 1
            FROM pragma_table_info('projects')
            WHERE name = 'document_bytes'
              AND upper(type) = 'INTEGER'
              AND "notnull" = 1
          ) AS projects_document_bytes,
          EXISTS (
            SELECT 1
            FROM pragma_table_info('revisions')
            WHERE name = 'document_bytes'
              AND upper(type) = 'INTEGER'
              AND "notnull" = 1
          ) AS revisions_document_bytes,
          (
            EXISTS (
              SELECT 1
              FROM sqlite_schema
              WHERE type = 'index'
                AND name = 'idx_revisions_project_bytes'
                AND tbl_name = 'revisions'
            )
            AND EXISTS (
              SELECT 1
              FROM pragma_index_info('idx_revisions_project_bytes')
              WHERE seqno = 0 AND name = 'project_id'
            )
            AND EXISTS (
              SELECT 1
              FROM pragma_index_info('idx_revisions_project_bytes')
              WHERE seqno = 1 AND name = 'document_bytes'
            )
            AND (
              SELECT COUNT(*)
              FROM pragma_index_info('idx_revisions_project_bytes')
            ) = 2
          ) AS revisions_bytes_index`
      )
      .first<DocumentStorageAccountingSchema>();

    return (
      schema?.projects_document_bytes === 1 &&
      schema.revisions_document_bytes === 1 &&
      schema.revisions_bytes_index === 1
    );
  } catch {
    return false;
  }
}

/** Whether migration 0011 and a writable private R2 binding are present. */
export async function isProjectObjectStorageReady(
  db: D1Database | undefined,
  bucket: R2Bucket | undefined
): Promise<boolean> {
  if (
    !db ||
    !bucket ||
    typeof bucket.put !== 'function' ||
    typeof bucket.get !== 'function' ||
    typeof bucket.delete !== 'function'
  ) {
    return false;
  }

  try {
    const schema = await db
      .prepare(
        `SELECT
          (
            SELECT COUNT(*)
            FROM pragma_table_info('projects')
            WHERE name IN (
              'document_object_id', 'last_revision_id', 'revision_count'
            )
          ) AS project_columns,
          EXISTS (
            SELECT 1 FROM pragma_table_info('revisions')
            WHERE name = 'document_object_id'
          ) AS revision_pointer,
          EXISTS (
            SELECT 1 FROM sqlite_schema
            WHERE type = 'table' AND name = 'project_document_objects'
          ) AS document_objects_table,
          EXISTS (
            SELECT 1 FROM sqlite_schema
            WHERE type = 'table' AND name = 'project_storage_assets'
          ) AS storage_assets_table,
          EXISTS (
            SELECT 1 FROM sqlite_schema
            WHERE type = 'index'
              AND name = 'idx_project_document_objects_project_state'
          ) AS document_objects_index,
          EXISTS (
            SELECT 1 FROM sqlite_schema
            WHERE type = 'index'
              AND name = 'idx_project_storage_assets_project'
          ) AS storage_assets_index,
          (
            SELECT COUNT(*) FROM sqlite_schema
            WHERE type = 'index' AND name IN (
              'idx_projects_document_object',
              'idx_revisions_document_object'
            )
          ) AS pointer_indexes`
      )
      .first<ProjectObjectStorageSchema>();

    return (
      schema?.project_columns === 3 &&
      schema.revision_pointer === 1 &&
      schema.document_objects_table === 1 &&
      schema.storage_assets_table === 1 &&
      schema.document_objects_index === 1 &&
      schema.storage_assets_index === 1 &&
      schema.pointer_indexes === 2
    );
  } catch {
    return false;
  }
}
