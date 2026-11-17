-- L08 commenter links on end-to-end encrypted projects (plan decisions 2 and
-- 3a). The owner lets one link's visitors comment with an owner-signed
-- comment grant, kept here beside the link rather than as a link-grant mode
-- inside the encrypted document, so older builds still open the project. A
-- visitor's comment is an unsigned `share-comment` project envelope whose key
-- is wrapped under the link's share key: the account stores ciphertext only.
-- Both go with their link (and so with the project); the owner can hide a
-- comment, which deletes it.

CREATE TABLE IF NOT EXISTS e2ee_share_comment_grants (
  project_id TEXT NOT NULL,
  share_id TEXT NOT NULL,
  -- base64url of the canonical grant (at most 335 bytes) and its 65-byte
  -- signature.
  grant_statement TEXT NOT NULL
    CHECK (length(grant_statement) BETWEEN 1 AND 450),
  grant_signature TEXT NOT NULL CHECK (length(grant_signature) = 87),
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, share_id),
  FOREIGN KEY (project_id, share_id)
    REFERENCES e2ee_share_links(project_id, share_id) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS e2ee_share_comments (
  project_id TEXT NOT NULL,
  share_id TEXT NOT NULL,
  comment_id TEXT NOT NULL CHECK (length(comment_id) BETWEEN 1 AND 128),
  -- base64url of the envelope (a 64 KiB body at most, compressed or not)
  -- and of its 41-byte `share-comment-key` wrap.
  envelope TEXT NOT NULL CHECK (length(envelope) BETWEEN 1 AND 90000),
  wrapped_version_key TEXT NOT NULL CHECK (length(wrapped_version_key) = 55),
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, comment_id),
  FOREIGN KEY (project_id, share_id)
    REFERENCES e2ee_share_links(project_id, share_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS e2ee_share_comments_by_link
  ON e2ee_share_comments (project_id, share_id, created_at);

-- Account erasure of the project's owner fences new rows.
CREATE TRIGGER IF NOT EXISTS block_erasing_e2ee_share_comment_insert
BEFORE INSERT ON e2ee_share_comments
WHEN EXISTS (
  SELECT 1 FROM account_erasure_requests erasure
  JOIN projects ON projects.user_id = erasure.user_id
  WHERE projects.id = NEW.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ERASURE_IN_PROGRESS');
END;

CREATE TRIGGER IF NOT EXISTS block_erasing_e2ee_share_comment_grant_insert
BEFORE INSERT ON e2ee_share_comment_grants
WHEN EXISTS (
  SELECT 1 FROM account_erasure_requests erasure
  JOIN projects ON projects.user_id = erasure.user_id
  WHERE projects.id = NEW.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ERASURE_IN_PROGRESS');
END;
