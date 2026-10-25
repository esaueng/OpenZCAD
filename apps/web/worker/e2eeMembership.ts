/**
 * Membership changes stated by MLS Commits on encrypted projects (ADR-024
 * Phase 5, slice 5-4; roadmap L11). The Worker cannot read a Commit's
 * proposals the way a member's MLS policy does, so a Commit states the
 * membership change it makes, and the Worker checks that statement against
 * what it can see and mirrors it into `project_members` in the Commit's own
 * batch:
 *
 * - **Role changes** (`roles`, the owner's `setRoles`): only the owner
 *   states them, only for current members, and only `editor` or `viewer`.
 *   The mirror (`project_members.role`) and an access event land with the
 *   Commit or not at all, and the Commit row's insert is gated on every
 *   target still holding the role the check read.
 * - **Dropped identities** (`dropUsers`, the owner's removal of a member
 *   with all of its leaves): only the owner states them, never itself. The
 *   member's `project_members` row goes in the same batch, with an access
 *   event; a member who already left (slice 5-5) has no row left to drop.
 * - **The roles a new epoch holds.** Every Commit carries its new epoch's
 *   GroupInfo, whose GroupContext lists the roles every member's MLS policy
 *   agreed on. The Worker compares them with the current epoch's (from the
 *   stored GroupInfo): the new roles must be the old ones with exactly the
 *   stated changes applied (an Add's invitee with its invitation's role,
 *   the stated role changes and drops), and the owner never changes
 *   (ownership transfer is refused on encrypted projects). Anything else is
 *   refused with 409 `E2EE_ROLES_MISMATCH`, so a role change nobody stated,
 *   or a stated one the Commit does not make, never reaches the mirror.
 *   This is defense in depth: the GroupInfo is the committer's own
 *   statement, and browsers check the Commit itself, by the MLS policy and
 *   the roles of each version's own epoch.
 */
import { fromBase64Url } from '@openzcad/crypto';
import type { E2eeMlsRoleChange } from '@openzcad/shared';
import {
  parseGroupInfoContext,
  type EpochContext
} from '../src/lib/e2ee/mls/epochRoles';
import { CHAINED, idField, invalid, record, refuse } from './e2eeProjects';

type MemberRole = E2eeMlsRoleChange['role'];

/** Most members one Commit changes or drops (judgment; D1 binds 100 values). */
const MAX_TARGETS = 16;

/** What a stated membership change adds to its Commit's batch. */
export interface PreparedMembership {
  /** ANDed into the Commit row's own insert, which gates the batch. */
  readonly gateSql: string;
  readonly gateBinds: readonly unknown[];
  /** The owner's stated drops, for the batch's cleanup (slice 5-5). */
  readonly dropped: readonly string[];
  /** Chained after the rest of the Commit's batch (each changes one row). */
  chained(now: string): D1PreparedStatement[];
  /** Explains a batch that did not land although the epoch was free. */
  explain(): Promise<never>;
}

const ownershipRefused = (): never =>
  refuse(
    409,
    'E2EE_OWNERSHIP_TRANSFER_UNAVAILABLE',
    'An encrypted project’s owner cannot be changed.'
  );

function droppedUsers(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_TARGETS) {
    invalid(`dropUsers must list at most ${MAX_TARGETS} users`);
  }
  const list = value.map((item, index) => idField(item, `dropUsers[${index}]`));
  if (new Set(list).size !== list.length) {
    invalid('dropUsers names a user twice');
  }
  return list;
}

function roleChanges(value: unknown): E2eeMlsRoleChange[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_TARGETS) {
    invalid(`roles must list at most ${MAX_TARGETS} role changes`);
  }
  const list = value.map((item, index): E2eeMlsRoleChange => {
    const entry = record(item, `roles[${index}]`);
    const userId = idField(entry.userId, `roles[${index}].userId`);
    if (entry.role === 'owner') ownershipRefused();
    if (entry.role !== 'editor' && entry.role !== 'viewer') {
      invalid(`roles[${index}].role must be editor or viewer`);
    }
    return { userId, role: entry.role };
  });
  if (new Set(list.map((entry) => entry.userId)).size !== list.length) {
    invalid('roles names a member twice');
  }
  return list;
}

/** The roles a base64url GroupInfo lists; null when unreadable. */
function readRoles(groupInfo: string): EpochContext | null {
  try {
    return parseGroupInfoContext(fromBase64Url(groupInfo));
  } catch {
    return null;
  }
}

const roleMap = (context: EpochContext) =>
  new Map<string, string>(
    context.roles.users.map((user) => [user.userId, user.role])
  );

const mismatch = (detail: string): never =>
  refuse(
    409,
    'E2EE_ROLES_MISMATCH',
    `This Commit’s roles do not match the change it states (${detail}). Nothing was changed.`
  );

async function memberRole(
  db: D1Database,
  projectId: string,
  userId: string
): Promise<MemberRole | null> {
  const row = await db
    .prepare(
      'SELECT role FROM project_members WHERE project_id = ? AND user_id = ?'
    )
    .bind(projectId, userId)
    .first<{ role: string }>();
  return row?.role === 'editor' || row?.role === 'viewer' ? row.role : null;
}

/**
 * Checks the membership change a Commit states (slice 5-4) against the
 * stored members and the roles of the current and new epoch, and returns
 * what the Commit's batch needs. `groupInfo` is the new epoch's, from the
 * request; `storedGroupInfo` the current epoch's, from the group row.
 */
export async function prepareMembershipCommit(
  db: D1Database,
  input: {
    readonly userId: string;
    readonly projectId: string;
    readonly epoch: number;
    readonly kind: 'commit' | 'external';
    readonly storedGroupInfo: string;
    readonly groupInfo: string;
    readonly roles: unknown;
    readonly dropUsers: unknown;
    /** An Add's invitee, with the role its invitation names. */
    readonly invitee: {
      readonly userId: string;
      readonly role: MemberRole;
    } | null;
  }
): Promise<PreparedMembership> {
  const { userId, projectId, epoch } = input;
  const roles = roleChanges(input.roles);
  const drops = droppedUsers(input.dropUsers);
  if (drops.some((id) => roles.some((change) => change.userId === id))) {
    invalid('A Commit does not both change and drop one member');
  }
  const project = await db
    .prepare('SELECT user_id FROM projects WHERE id = ?')
    .bind(projectId)
    .first<{ user_id: string }>();
  if (!project) refuse(404, 'PROJECT_NOT_FOUND', 'Project not found.');
  const owner = project.user_id;

  // The stated changes: the owner's, for current members.
  const previous = new Map<string, MemberRole>();
  const droppedRows = new Map<string, MemberRole | null>();
  if (roles.length || drops.length) {
    if (input.kind !== 'commit') invalid('Only a Commit changes roles');
    if (userId !== owner) {
      refuse(
        403,
        'E2EE_PROJECT_OWNER_ONLY',
        'Only the owner can change roles in an encrypted project.'
      );
    }
    for (const change of roles) {
      if (change.userId === owner) ownershipRefused();
      const role = await memberRole(db, projectId, change.userId);
      if (!role) {
        refuse(
          409,
          'E2EE_MEMBER_NOT_FOUND',
          'That person is not a member of this project.'
        );
      }
      previous.set(change.userId, role);
    }
    for (const id of drops) {
      if (id === owner) ownershipRefused();
      // A member who left (slice 5-5) has no row left.
      droppedRows.set(id, await memberRole(db, projectId, id));
    }
  }

  // The new epoch's roles are the current ones with exactly that applied.
  const next = readRoles(input.groupInfo);
  if (!next) {
    invalid('groupInfo must be an MLS GroupInfo listing the project’s roles');
  }
  if (next.epoch !== epoch + 1) {
    invalid(`groupInfo must be for epoch ${epoch + 1}`);
  }
  const nextRoles = roleMap(next);
  const nextOwner = next.roles.users.find((u) => u.role === 'owner')?.userId;
  if (nextOwner !== owner) ownershipRefused();
  const current = readRoles(input.storedGroupInfo);
  if (current) {
    const expected = roleMap(current);
    if (input.invitee) expected.set(input.invitee.userId, input.invitee.role);
    for (const change of roles) expected.set(change.userId, change.role);
    for (const id of drops) {
      if (!expected.has(id)) mismatch(`${id} holds no role to drop`);
      expected.delete(id);
    }
    for (const id of new Set([...expected.keys(), ...nextRoles.keys()])) {
      if (expected.get(id) !== nextRoles.get(id)) {
        mismatch(
          `${id}: ${nextRoles.get(id) ?? 'no role'} where ${expected.get(id) ?? 'no role'} was expected`
        );
      }
    }
  } else if (roles.length || drops.length || input.invitee) {
    // Never the case for a group the Worker stored; refuse to guess.
    mismatch('the current epoch’s roles could not be read');
  }

  // Every target still as the check read it, inside the Commit's insert.
  const memberHolds =
    'EXISTS (SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ? AND role = ?)';
  const memberGone =
    'NOT EXISTS (SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?)';
  const stated = roles.length > 0 || drops.length > 0;
  const gateSql = stated
    ? [
        'EXISTS (SELECT 1 FROM projects WHERE id = ? AND user_id = ?)',
        ...roles.map(() => memberHolds),
        ...drops.map((id) => (droppedRows.get(id) ? memberHolds : memberGone))
      ].join(' AND ')
    : '';
  const gateBinds = stated
    ? [
        projectId,
        owner,
        ...roles.flatMap((change) => [
          projectId,
          change.userId,
          previous.get(change.userId)
        ]),
        ...drops.flatMap((id) => {
          const role = droppedRows.get(id);
          return role ? [projectId, id, role] : [projectId, id];
        })
      ]
    : [];
  return {
    gateSql,
    gateBinds,
    dropped: drops,
    chained: (now) => {
      const seconds = Math.floor(Date.parse(now) / 1000);
      const metadata = JSON.stringify({ encrypted: true, epoch });
      const changed = roles.flatMap((change) => [
        db
          .prepare(
            `INSERT INTO project_access_events
               (project_id, actor_user_id, subject_user_id, event_type,
                previous_role, next_role, created_at, metadata_json)
             SELECT ?, ?, ?, 'member-role-changed', ?, ?, ?, ?
             WHERE ${CHAINED}`
          )
          .bind(
            projectId,
            userId,
            change.userId,
            previous.get(change.userId),
            change.role,
            seconds,
            metadata
          ),
        // The server's mirror of the role the Commit's roles extension sets.
        db
          .prepare(
            `UPDATE project_members SET role = ?, updated_at = ?
             WHERE project_id = ? AND user_id = ? AND ${CHAINED}`
          )
          .bind(change.role, seconds, projectId, change.userId)
      ]);
      const removed = drops.flatMap((id) => {
        const role = droppedRows.get(id);
        if (!role) return [];
        return [
          db
            .prepare(
              `INSERT INTO project_access_events
                 (project_id, actor_user_id, subject_user_id, event_type,
                  previous_role, created_at, metadata_json)
               SELECT ?, ?, ?, 'member-removed', ?, ?, ?
               WHERE ${CHAINED}`
            )
            .bind(projectId, userId, id, role, seconds, metadata),
          // The server's mirror of the identity the Commit drops.
          db
            .prepare(
              `DELETE FROM project_members
               WHERE project_id = ? AND user_id = ? AND ${CHAINED}`
            )
            .bind(projectId, id)
        ];
      });
      return [...changed, ...removed];
    },
    explain: async () => {
      const read: [string, MemberRole | null][] = [
        ...roles.map((change): [string, MemberRole | null] => [
          change.userId,
          previous.get(change.userId) ?? null
        ]),
        ...drops.map((id): [string, MemberRole | null] => [
          id,
          droppedRows.get(id) ?? null
        ])
      ];
      for (const [id, role] of read) {
        if ((await memberRole(db, projectId, id)) !== role) {
          refuse(
            409,
            'E2EE_MEMBER_CHANGED',
            'That member’s access changed meanwhile. Reload and try again.'
          );
        }
      }
      refuse(
        401,
        'E2EE_SESSION_REQUIRED',
        'Sign in again before changing encryption keys.'
      );
    }
  };
}
