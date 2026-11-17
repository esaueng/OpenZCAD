-- Which attempt a project's migration row holds: a counter that every new
-- staging (a start from `abandoned` or `done`, either direction) moves on,
-- and nothing else changes. An attempt is the row's state and this counter.
-- A start or resume may name the attempt its browser read
-- (`expectedAttempt`); the Worker fences its write on it in the same
-- statement and refuses with E2EE_MIGRATION_ATTEMPT_CHANGED when another
-- tab or device started, cancelled or restarted the migration in between,
-- so an owner's approval of the members given for one attempt never goes
-- ahead with another (#1465 review). The start time is wall-clock and need
-- not differ between two attempts; this counter always does.
--
-- Rows from before this migration count as their first attempt. Until it
-- is applied the Worker fences on the state and start time instead, and a
-- record carries no `attempt`.

ALTER TABLE e2ee_project_migrations
  ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1);

-- Every writer that begins a new staging moves the counter on: the encrypt
-- and decrypt starts today, and any later one, without naming the column.
-- A resume (staging to staging) and every other move leave it as it is.
CREATE TRIGGER IF NOT EXISTS e2ee_project_migration_attempt
AFTER UPDATE OF state ON e2ee_project_migrations
WHEN OLD.state <> 'staging' AND NEW.state = 'staging'
BEGIN
  UPDATE e2ee_project_migrations SET attempt = OLD.attempt + 1
  WHERE project_id = NEW.project_id;
END;
