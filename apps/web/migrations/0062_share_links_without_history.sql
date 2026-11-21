-- L08: a share link may serve the finished model without its history.
--
-- Plaintext links (project_share_links). Such a link never reads the live
-- project: it serves `frozen_document`, the model as the owner's browser
-- froze it (one imported exact solid per body; gzip, base64), last replaced
-- at `frozen_at` (Unix seconds) by the owner's Update. Revoking the link
-- clears the document. Every existing link keeps history = 1 and serves the
-- live project as before.
--
-- Encrypted links are migration 0063.
--
-- Additive: until this is applied the Worker names none of these columns
-- (it probes for them first), every link reads as sharing its history, and
-- creating a link without history is refused.

ALTER TABLE project_share_links
  ADD COLUMN history INTEGER NOT NULL DEFAULT 1 CHECK (history IN (0, 1));
ALTER TABLE project_share_links ADD COLUMN frozen_document TEXT;
ALTER TABLE project_share_links
  ADD COLUMN frozen_at INTEGER CHECK (frozen_at IS NULL OR frozen_at >= 0);

-- A link never changes between sharing the live project and a frozen model.
CREATE TRIGGER IF NOT EXISTS project_share_link_history_immutable
BEFORE UPDATE OF history ON project_share_links
WHEN NEW.history <> OLD.history
BEGIN
  SELECT RAISE(ABORT, 'SHARE_LINK_HISTORY_IMMUTABLE');
END;

-- The frozen model goes when the link is revoked, whoever revokes it: the
-- owner, or the cutover that encrypts the project (which must leave no
-- plaintext of it behind). That it had no history stays on the row.
CREATE TRIGGER IF NOT EXISTS project_share_link_revoked_forgets_model
AFTER UPDATE OF revoked_at ON project_share_links
WHEN NEW.revoked_at IS NOT NULL AND NEW.frozen_document IS NOT NULL
BEGIN
  UPDATE project_share_links SET frozen_document = NULL WHERE id = NEW.id;
END;
