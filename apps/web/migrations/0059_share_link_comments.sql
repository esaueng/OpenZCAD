-- L08 commenter links: a plaintext project's share link may let its
-- visitors comment (view or tweak, plus comments). Off for every existing
-- link. An encrypted project's links never use this column; their mode is
-- in the owner-signed grant (see docs/plans/l08-l03-review-and-versions-plan.md).

ALTER TABLE project_share_links
  ADD COLUMN allow_comments INTEGER NOT NULL DEFAULT 0
  CHECK (allow_comments IN (0, 1));

-- A visitor's comment records the link it came through, so revoking the link
-- or deleting the project leaves no orphan and members can see the source.
ALTER TABLE project_comments
  ADD COLUMN share_link_id TEXT REFERENCES project_share_links(id)
  ON DELETE SET NULL;
