-- L08: a share link may serve the finished model without its history.
--
-- Plaintext links (project_share_links). Such a link never reads the live
-- project: it serves `frozen_document`, the model as the owner's browser
-- froze it (one imported exact solid per body; gzip, base64), last replaced
-- at `frozen_at` (Unix seconds) by the owner's Update. Revoking the link
-- clears the document. Every existing link keeps history = 1 and serves the
-- live project as before.
--
-- Encrypted links are migration 0066.
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

-- A link without history keeps its token hash in a domain of its own: the
-- prefix below, where a link to the live project stores the bare SHA-256
-- hex of its token. A Worker from before this migration looks up the bare
-- hash and serves the live project for the row it finds, so it must never
-- find one of these; with the prefix it cannot, whatever it runs. These
-- hold every row to its domain, so that does not rest on the code that
-- writes them.
CREATE TRIGGER IF NOT EXISTS project_share_link_token_domain_insert
BEFORE INSERT ON project_share_links
WHEN (NEW.history = 0) <> (substr(NEW.token_hash, 1, 10) = 'frozen-v1:')
BEGIN
  SELECT RAISE(ABORT, 'SHARE_LINK_TOKEN_DOMAIN');
END;

CREATE TRIGGER IF NOT EXISTS project_share_link_token_domain_update
BEFORE UPDATE OF token_hash ON project_share_links
WHEN (NEW.history = 0) <> (substr(NEW.token_hash, 1, 10) = 'frozen-v1:')
BEGIN
  SELECT RAISE(ABORT, 'SHARE_LINK_TOKEN_DOMAIN');
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
