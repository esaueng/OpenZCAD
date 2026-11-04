-- Owner-only names for plaintext share links ("Supplier review"), so an owner
-- can tell links apart before revoking one. Visitors never receive the label:
-- the anonymous share routes do not select it. NULL means unnamed; the
-- Worker trims it to 1-60 characters, and revoking a link clears it.
-- Encrypted share links (e2ee_share_links) are untouched: their names would
-- belong in the encrypted project document, not in a server column.

ALTER TABLE project_share_links
  ADD COLUMN label TEXT CHECK (label IS NULL OR length(label) BETWEEN 1 AND 60);
