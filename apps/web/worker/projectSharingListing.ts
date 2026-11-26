import {
  PROJECT_SHARE_LINK_TTL_SECONDS,
  type ListProjectsResponse,
  type ProjectMemberRole,
  type ProjectSummarySharing
} from '@openzcad/shared';
import { isE2eeShareLinkStorageReady } from '@openzcad/cloudflare-adapters';

interface MemberRow {
  project_id: string;
  role: ProjectMemberRole;
}

interface CountRow {
  project_id: string;
  n: number;
}

/**
 * `GET /api/projects`: marks each listed project's sharing (see
 * `ProjectSummary.sharing`) so the shelf can gather shared projects
 * and tag their cards without asking each project's sharing route. A
 * project shared with the caller carries the caller's role; the caller's
 * own project carries its member and live-link counts while either is
 * above zero. Never fails the listing: an unreachable answer leaves it
 * unmarked, which reads as unshared.
 */
export async function withProjectSharing<T extends ListProjectsResponse>(
  db: D1Database | undefined,
  userId: string,
  listing: T,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): Promise<T> {
  if (!db || listing.projects.length === 0) return listing;
  try {
    const linkCutoff = nowSeconds - PROJECT_SHARE_LINK_TTL_SECONDS;
    const statements = [
      db
        .prepare(
          `SELECT project_id, role FROM project_members
           WHERE user_id = ? AND role IN ('editor', 'viewer')`
        )
        .bind(userId),
      db
        .prepare(
          `SELECT m.project_id, COUNT(*) AS n
           FROM project_members m
           JOIN projects p ON p.id = m.project_id
           WHERE p.user_id = ? AND m.user_id != p.user_id
           GROUP BY m.project_id`
        )
        .bind(userId),
      db
        .prepare(
          `SELECT l.project_id, COUNT(*) AS n
           FROM project_share_links l
           JOIN projects p ON p.id = l.project_id
           WHERE p.user_id = ? AND l.revoked_at IS NULL AND l.created_at > ?
           GROUP BY l.project_id`
        )
        .bind(userId, linkCutoff)
    ];
    // An encrypted link lives until revoked: its authority is renewed while
    // it stands (the same test the link limit counts by).
    if (await isE2eeShareLinkStorageReady(db)) {
      statements.push(
        db
          .prepare(
            `SELECT l.project_id, COUNT(*) AS n
             FROM e2ee_share_links l
             JOIN projects p ON p.id = l.project_id
             WHERE p.user_id = ? AND l.revoked_at IS NULL
             GROUP BY l.project_id`
          )
          .bind(userId)
      );
    }
    const [members, memberCounts, ...linkCounts] = await db.batch(statements);
    const roles = new Map<string, ProjectMemberRole>();
    for (const row of (members?.results ?? []) as MemberRow[]) {
      roles.set(row.project_id, row.role);
    }
    const memberCountOf = countsByProject(
      (memberCounts?.results ?? []) as CountRow[]
    );
    const linkCountOf = countsByProject(
      linkCounts.flatMap((result) => (result.results ?? []) as CountRow[])
    );
    return {
      ...listing,
      projects: listing.projects.map((project) => {
        const sharing = sharingOf(
          project.projectId,
          roles,
          memberCountOf,
          linkCountOf
        );
        return sharing ? { ...project, sharing } : project;
      })
    };
  } catch {
    return listing;
  }
}

function countsByProject(rows: CountRow[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const n = Number(row.n);
    if (Number.isFinite(n) && n > 0) {
      counts.set(row.project_id, (counts.get(row.project_id) ?? 0) + n);
    }
  }
  return counts;
}

function sharingOf(
  projectId: string,
  roles: ReadonlyMap<string, ProjectMemberRole>,
  memberCounts: ReadonlyMap<string, number>,
  linkCounts: ReadonlyMap<string, number>
): ProjectSummarySharing | null {
  const role = roles.get(projectId);
  if (role) return { role };
  const memberCount = memberCounts.get(projectId) ?? 0;
  const linkCount = linkCounts.get(projectId) ?? 0;
  if (memberCount === 0 && linkCount === 0) return null;
  return {
    role: 'owner',
    ...(memberCount > 0 ? { memberCount } : {}),
    ...(linkCount > 0 ? { linkCount } : {})
  };
}
