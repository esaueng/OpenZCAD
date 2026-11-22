-- L08: an end-to-end encrypted share link may serve the finished model
-- without its history (plaintext links: migration 0065).
--
-- The owner-signed grant carries the third mode, `frozen`. The row in
-- e2ee_share_links (migration 0040) keeps mode = 'view', so that column's
-- CHECK is unchanged, with history = 0, and never changes it afterwards.
-- The frozen model is inside the encrypted share snapshot, as for every
-- encrypted link; the server stores nothing new of it.
--
-- Additive: until this is applied the Worker does not name the column (it
-- probes for it first), every link reads with its stored mode, and
-- registering a link without history is refused.

ALTER TABLE e2ee_share_links
  ADD COLUMN history INTEGER NOT NULL DEFAULT 1 CHECK (history IN (0, 1));

CREATE TRIGGER IF NOT EXISTS e2ee_share_link_history_immutable
BEFORE UPDATE OF history ON e2ee_share_links
WHEN NEW.history <> OLD.history
BEGIN
  SELECT RAISE(ABORT, 'E2EE_SHARE_LINK_IMMUTABLE');
END;
