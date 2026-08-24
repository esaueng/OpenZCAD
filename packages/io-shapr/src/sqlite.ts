import sqlite3InitModule, {
  type Database,
  type Sqlite3Static
} from '@sqlite.org/sqlite-wasm';

import type { ShaprDatabase, ShaprDatabaseRow } from './types';

const SQLITE_HEADER = new TextEncoder().encode('SQLite format 3\0');
const MAX_SQL_BYTES = 64 * 1024;
const MAX_COLUMNS = 256;
const MAX_EXPRESSION_DEPTH = 64;

let sqlitePromise: Promise<Sqlite3Static> | null = null;

function sqlite(): Promise<Sqlite3Static> {
  sqlitePromise ??= sqlite3InitModule();
  return sqlitePromise;
}

function validateSqliteHeader(bytes: Uint8Array, maxBytes: number): void {
  if (bytes.byteLength < 100 || bytes.byteLength > maxBytes) {
    throw new Error('SHAPR workspace database size is invalid.');
  }
  if (SQLITE_HEADER.some((byte, index) => bytes[index] !== byte)) {
    throw new Error('SHAPR workspace entry is not a SQLite 3 database.');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const rawPageSize = view.getUint16(16, false);
  const pageSize = rawPageSize === 1 ? 65_536 : rawPageSize;
  if (
    pageSize < 512 ||
    pageSize > 65_536 ||
    (pageSize & (pageSize - 1)) !== 0
  ) {
    throw new Error('SHAPR workspace database declares an invalid page size.');
  }
  const pageCount = view.getUint32(28, false);
  if (pageCount === 0 || pageCount * pageSize > bytes.byteLength) {
    throw new Error('SHAPR workspace database page bounds are invalid.');
  }
}

function configureDefensiveMode(
  sqlite3: Sqlite3Static,
  database: Database
): void {
  const pointer = database.pointer;
  if (pointer === undefined) {
    throw new Error('SQLite database did not open.');
  }
  const { capi } = sqlite3;
  const configs: Array<[number, number]> = [
    [capi.SQLITE_DBCONFIG_DEFENSIVE, 1],
    [capi.SQLITE_DBCONFIG_TRUSTED_SCHEMA, 0],
    [capi.SQLITE_DBCONFIG_DQS_DDL, 0],
    [capi.SQLITE_DBCONFIG_DQS_DML, 0],
    [capi.SQLITE_DBCONFIG_ENABLE_LOAD_EXTENSION, 0],
    [capi.SQLITE_DBCONFIG_ENABLE_ATTACH_CREATE, 0],
    [capi.SQLITE_DBCONFIG_ENABLE_ATTACH_WRITE, 0]
  ];
  for (const [configuration, enabled] of configs) {
    database.checkRc(
      capi.sqlite3_db_config(pointer, configuration as never, enabled, 0)
    );
  }
  capi.sqlite3_limit(pointer, capi.SQLITE_LIMIT_LENGTH, 64 * 1024 * 1024);
  capi.sqlite3_limit(pointer, capi.SQLITE_LIMIT_SQL_LENGTH, MAX_SQL_BYTES);
  capi.sqlite3_limit(pointer, capi.SQLITE_LIMIT_COLUMN, MAX_COLUMNS);
  capi.sqlite3_limit(
    pointer,
    capi.SQLITE_LIMIT_EXPR_DEPTH,
    MAX_EXPRESSION_DEPTH
  );
  capi.sqlite3_limit(pointer, capi.SQLITE_LIMIT_COMPOUND_SELECT, 8);
  database.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;');
}

class WasmShaprDatabase implements ShaprDatabase {
  constructor(private readonly database: Database) {}

  all(sql: string): ShaprDatabaseRow[] {
    if (new TextEncoder().encode(sql).byteLength > MAX_SQL_BYTES) {
      throw new Error('Internal SHAPR query exceeds the SQL limit.');
    }
    return this.database.exec({
      sql,
      rowMode: 'object',
      returnValue: 'resultRows'
    });
  }

  close(): void {
    this.database.close();
  }
}

export async function openShaprDatabase(
  bytes: Uint8Array,
  maxBytes: number
): Promise<ShaprDatabase> {
  validateSqliteHeader(bytes, maxBytes);
  const sqlite3 = await sqlite();
  // SQLite's immutable URI is the supported way to read a checkpointed main
  // database while ignoring absent journal/WAL sidecars. The POSIX helper
  // writes only to SQLite-WASM's in-memory VFS; the parser worker is terminated
  // after each preview, so neither the browser filesystem nor source survives.
  const virtualPath = '/openzcad-shapr-workspace.sqlite3';
  sqlite3.capi.sqlite3_js_posix_create_file(virtualPath, bytes);
  const database = new sqlite3.oo1.DB({
    filename: `file:${virtualPath}?immutable=1`,
    flags: 'r'
  });
  try {
    configureDefensiveMode(sqlite3, database);
    return new WasmShaprDatabase(database);
  } catch (error) {
    database.close();
    throw error;
  }
}
