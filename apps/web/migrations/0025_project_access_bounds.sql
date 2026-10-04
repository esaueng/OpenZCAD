-- Access metadata is bounded independently of document/blob storage quotas.
-- Keep the newest 1,000 audit events and 100 revoked links per project.
DELETE FROM project_access_events WHERE id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY created_at DESC, id DESC) AS position
    FROM project_access_events
  ) WHERE position > 1000
);
DELETE FROM project_share_links WHERE id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY revoked_at DESC, id DESC) AS position
    FROM project_share_links WHERE revoked_at IS NOT NULL
  ) WHERE position > 100
);

CREATE TRIGGER IF NOT EXISTS project_share_link_active_limit
BEFORE INSERT ON project_share_links
WHEN (SELECT COUNT(*) FROM project_share_links WHERE project_id = NEW.project_id AND revoked_at IS NULL) >= 100
BEGIN
  SELECT RAISE(ABORT, 'SHARE_LINK_LIMIT_REACHED');
END;

CREATE TRIGGER IF NOT EXISTS project_share_link_revoked_retention
AFTER UPDATE OF revoked_at ON project_share_links
WHEN NEW.revoked_at IS NOT NULL
BEGIN
  DELETE FROM project_share_links WHERE project_id = NEW.project_id AND revoked_at IS NOT NULL
    AND id NOT IN (SELECT id FROM project_share_links WHERE project_id = NEW.project_id AND revoked_at IS NOT NULL ORDER BY revoked_at DESC, id DESC LIMIT 100);
END;

CREATE TRIGGER IF NOT EXISTS project_access_event_retention
AFTER INSERT ON project_access_events
BEGIN
  DELETE FROM project_access_events WHERE project_id = NEW.project_id
    AND id NOT IN (SELECT id FROM project_access_events WHERE project_id = NEW.project_id ORDER BY created_at DESC, id DESC LIMIT 1000);
END;
