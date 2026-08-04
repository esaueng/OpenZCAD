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
