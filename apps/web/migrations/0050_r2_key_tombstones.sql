-- R2 key tombstones: a cleanup's R2 delete can never remove bytes a newer
-- row stores under the same key.
--
-- Two key families are re-created by later writers: a source asset's key
-- is content-addressed (`project-storage/<project>/assets/<checksum>.…`),
-- and an encrypted blob's key is addressed by its blob id
-- (`e2ee/<project>/<blob id>`), which a retried upload reuses. A cleanup
-- that read a row, paused, and then deleted that row's key could delete
-- what a newer row stores there (the content-addressed asset of a newer
-- decryption, the re-uploaded blob of a newer upload).
--
-- The protocol, which every key-reusing R2 delete follows
-- (`claimObjectKeysForDelete` in packages/cloudflare-adapters):
--
-- 1. The deleter claims each key in one D1 statement, only while its own
--    fence holds and no row other than the ones it is removing names the
--    key (upload sessions, encrypted blobs, source assets, artifacts,
--    document objects).
-- 2. It deletes from R2 only the keys it holds a fresh claim on.
-- 3. It removes its rows, then releases its claims.
--
-- While a claim is fresh, the triggers below refuse any new row that names
-- the key, so no writer can come to rely on bytes the deleter is about to
-- remove. A writer whose bytes reach R2 before its row (a source asset)
-- checks after its commit that its object is still there and stores it
-- again if not: a delete that preceded its row can only have come from a
-- claim released before its row, and no claim can be taken while its row
-- exists.
--
-- A claim is fresh for an hour. An older one (a cleanup that died between
-- steps) no longer blocks writers, and its deleter no longer deletes.
CREATE TABLE IF NOT EXISTS r2_key_tombstones (
  object_key TEXT PRIMARY KEY CHECK (length(object_key) BETWEEN 1 AND 1024),
  token TEXT NOT NULL CHECK (length(token) BETWEEN 1 AND 64),
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS r2_key_tombstones_token
  ON r2_key_tombstones (token);

DROP TRIGGER IF EXISTS r2_key_tombstone_upload_session_guard;
CREATE TRIGGER r2_key_tombstone_upload_session_guard
BEFORE INSERT ON upload_sessions
BEGIN
  SELECT RAISE(ABORT, 'r2_key_deleting')
  WHERE EXISTS (
    SELECT 1 FROM r2_key_tombstones
    WHERE object_key = NEW.object_key
      AND created_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 3600000
  );
END;

DROP TRIGGER IF EXISTS r2_key_tombstone_content_blob_guard;
CREATE TRIGGER r2_key_tombstone_content_blob_guard
BEFORE INSERT ON e2ee_content_blobs
BEGIN
  SELECT RAISE(ABORT, 'r2_key_deleting')
  WHERE EXISTS (
    SELECT 1 FROM r2_key_tombstones
    WHERE object_key = NEW.object_key
      AND created_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 3600000
  );
END;

DROP TRIGGER IF EXISTS r2_key_tombstone_storage_asset_guard;
CREATE TRIGGER r2_key_tombstone_storage_asset_guard
BEFORE INSERT ON project_storage_assets
BEGIN
  SELECT RAISE(ABORT, 'r2_key_deleting')
  WHERE EXISTS (
    SELECT 1 FROM r2_key_tombstones
    WHERE object_key = NEW.object_key
      AND created_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 3600000
  );
END;

DROP TRIGGER IF EXISTS r2_key_tombstone_artifact_guard;
CREATE TRIGGER r2_key_tombstone_artifact_guard
BEFORE INSERT ON artifacts
BEGIN
  SELECT RAISE(ABORT, 'r2_key_deleting')
  WHERE EXISTS (
    SELECT 1 FROM r2_key_tombstones
    WHERE object_key = NEW.object_key
      AND created_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 3600000
  );
END;
