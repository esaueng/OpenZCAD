/**
 * Leaving an encrypted project, and losing access to it (ADR-024 Phase 5,
 * slice 5-5; roadmap L11; migration 0039).
 *
 * - `POST /api/e2ee/projects/:id/mls/proposals` (a member other than the
 *   owner): stores a SelfRemove proposal sent in the group's current epoch,
 *   for another member to commit by reference (a Commit may not remove its
 *   own sender, RFC 9420 §12.2). The member's access goes in the same batch
 *   (plan decision M4): its `project_members` row, with an access event,
 *   its account-wrapped keys of the project and its assistant consent. The
 *   Worker checks the framing (a PublicMessage proposal of the SelfRemove
 *   type, from a member, for this project's group and epoch); members'
 *   engines check the signature when they process it.
 * - `GET …/mls/proposals[?keyEpoch=]` (a member): the proposals still
 *   pending in a key epoch, those its Commit applied by reference (every
 *   member processes them before that Commit), and the members who left by
 *   one and hold no membership any more (the owner drops them from the
 *   roles).
 * - **Settling.** Every member Commit for a key epoch must settle each
 *   proposal still pending in it, as applied (committed by reference) or
 *   as rejected by the committer's engine (`prepareProposalSettlement`); the
 *   Commit row's insert is gated on exactly that set, so a Commit that raced
 *   a departure cannot leave it behind. An external Commit, which cannot
 *   carry proposals by reference, is refused while one is pending.
 * - **Losing access** (`accessCleanupStatements`): the owner's removal
 *   (`dropUsers`, `e2eeMembership.ts`) and leaving both delete the member's
 *   wraps of the project's keys and its assistant consent rows in their own
 *   batch. Deleting the wraps is housekeeping, not revocation: the member
 *   may have kept every key it held, and the new epoch the departure's
 *   Commit starts is what it cannot open.
 *
 * Without migration 0039 the listing is empty and says so, leaving answers
 * 503, and Commits, the owner's removals and role changes work as before.
 */
import { toHex } from '@openzcad/crypto';
import type {
  E2eeMlsProposalRecord,
  E2eeMlsProposalResponse,
  E2eeMlsProposalsResponse
} from '@openzcad/shared';
import {
  isE2eeAssistantConsentStorageReady,
  isE2eeMlsProposalStorageReady
} from '@openzcad/cloudflare-adapters';
import {
  parseSelfRemoveProposal,
  projectGroupId
} from '../src/lib/e2ee/mls/epochRoles';
import {
  CHAINED,
  MEMBER_FENCE,
  bytesField,
  fenceBinds,
  idField,
  invalid,
  json,
  queryUint,
  refuse,
  requireCertifiedDevice,
  runBatch,
  uintField,
  type Authorization,
  type BatchResult
} from './e2eeProjects';

/** A SelfRemove PublicMessage is well under 1 KiB (judgment; leave room). */
const MAX_PROPOSAL_BYTES = 16 * 1024;
/**
 * Most proposals one Commit settles (judgment): the Commit row's gate binds
 * one value per proposal, and D1 allows 100 bound values per statement.
 */
const MAX_SETTLED = 16;
const LIST_LIMIT = 100;

interface ProposalRow {
  key_epoch: number;
  proposal_hash: string;
  kind: 'self-remove';
  sender_user_id: string | null;
  sender_device_id: string | null;
  message: string;
  created_at: string;
}

const proposalRecord = (row: ProposalRow): E2eeMlsProposalRecord => ({
  keyEpoch: row.key_epoch,
  proposalHash: row.proposal_hash,
  kind: row.kind,
  senderUserId: row.sender_user_id,
  senderDeviceId: row.sender_device_id,
  message: row.message,
  createdAt: row.created_at
});

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((value, index) => value === b[index]);

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return toHex(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)
    )
  );
}

function randomHex(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

interface GroupPosition {
  readonly epoch: number;
  readonly key_epoch_base: number;
}

async function groupPosition(
  db: D1Database,
  projectId: string
): Promise<GroupPosition> {
  const row = await db
    .prepare(
      'SELECT epoch, key_epoch_base FROM e2ee_project_groups WHERE project_id = ?'
    )
    .bind(projectId)
    .first<GroupPosition>();
  if (!row) {
    refuse(
      404,
      'E2EE_GROUP_NOT_FOUND',
      'This encrypted project has no MLS group yet.'
    );
  }
  return row;
}

/** Proposals stored for the current epoch that no Commit settled yet. */
export async function pendingProposalCount(
  db: D1Database,
  projectId: string,
  keyEpoch: number
): Promise<number | null> {
  if (!(await isE2eeMlsProposalStorageReady(db))) return null;
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM e2ee_mls_proposals
       WHERE project_id = ? AND key_epoch = ? AND outcome IS NULL`
    )
    .bind(projectId, keyEpoch)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// --- Losing access -----------------------------------------------------------

/**
 * Deletes what a member who lost access kept of a project (slice 5-5): its
 * account-wrapped keys and its assistant consent rows. Each statement is
 * gated on `landedSql`, the proof that its batch's membership change
 * landed, since it changes any number of rows and cannot be chained.
 */
export async function accessCleanupStatements(
  db: D1Database,
  projectId: string,
  userId: string,
  landedSql: string,
  landedBinds: readonly unknown[]
): Promise<D1PreparedStatement[]> {
  return [
    db
      .prepare(
        `DELETE FROM e2ee_project_keys
         WHERE project_id = ? AND user_id = ? AND ${landedSql}`
      )
      .bind(projectId, userId, ...landedBinds),
    ...((await isE2eeAssistantConsentStorageReady(db))
      ? [
          db
            .prepare(
              `DELETE FROM e2ee_assistant_consents
               WHERE project_id = ? AND user_id = ? AND ${landedSql}`
            )
            .bind(projectId, userId, ...landedBinds)
        ]
      : [])
  ];
}

/**
 * The access event a removal or departure records, and the proof its batch
 * landed: the event carries a one-time `batch` value in its metadata, which
 * the batch's cleanup statements look for.
 */
export function removalEvent(details: Record<string, unknown>): {
  readonly metadata: string;
  readonly landedSql: string;
  landedBinds(projectId: string, userId: string): unknown[];
} {
  const metadata = JSON.stringify({ ...details, batch: randomHex() });
  return {
    metadata,
    landedSql: `EXISTS (SELECT 1 FROM project_access_events
      WHERE project_id = ? AND subject_user_id = ?
        AND event_type = 'member-removed' AND metadata_json = ?)`,
    landedBinds: (projectId, userId) => [projectId, userId, metadata]
  };
}

// --- Routes --------------------------------------------------------------------

/** `GET …/mls/proposals[?keyEpoch=]`: pending proposals and departed members. */
export async function listProposals(
  db: D1Database,
  projectId: string,
  url: URL
): Promise<Response> {
  const group = await groupPosition(db, projectId);
  const keyEpoch =
    queryUint(url, 'keyEpoch') ?? group.key_epoch_base + group.epoch;
  if (!(await isE2eeMlsProposalStorageReady(db))) {
    return json({
      available: false,
      keyEpoch,
      proposals: [],
      committed: [],
      departed: []
    } satisfies E2eeMlsProposalsResponse);
  }
  const listed = (outcome: string) =>
    db
      .prepare(
        `SELECT key_epoch, proposal_hash, kind, sender_user_id,
                sender_device_id, message, created_at
         FROM e2ee_mls_proposals
         WHERE project_id = ? AND key_epoch = ? AND ${outcome}
         ORDER BY created_at, proposal_hash LIMIT ?`
      )
      .bind(projectId, keyEpoch, LIST_LIMIT)
      .all<ProposalRow>();
  const { results } = await listed('outcome IS NULL');
  const committed = await listed("outcome = 'committed'");
  const departed = await db
    .prepare(
      `SELECT DISTINCT p.sender_user_id AS user_id FROM e2ee_mls_proposals p
       WHERE p.project_id = ? AND p.kind = 'self-remove'
         AND p.sender_user_id IS NOT NULL
         AND p.sender_user_id <> (SELECT user_id FROM projects WHERE id = ?)
         AND NOT EXISTS (SELECT 1 FROM project_members m
           WHERE m.project_id = p.project_id AND m.user_id = p.sender_user_id)
       ORDER BY 1 LIMIT ?`
    )
    .bind(projectId, projectId, LIST_LIMIT)
    .all<{ user_id: string }>();
  return json({
    available: true,
    keyEpoch,
    proposals: (results ?? []).map(proposalRecord),
    committed: (committed.results ?? []).map(proposalRecord),
    departed: (departed.results ?? []).map((row) => row.user_id)
  } satisfies E2eeMlsProposalsResponse);
}

/**
 * `POST …/mls/proposals`: a member leaves by a SelfRemove proposal, and
 * loses its access in the same batch (decision M4).
 */
export async function postProposal(
  db: D1Database,
  userId: string,
  projectId: string,
  authorization: Authorization,
  body: Record<string, unknown>
): Promise<Response> {
  if (!(await isE2eeMlsProposalStorageReady(db))) {
    refuse(
      503,
      'E2EE_UNAVAILABLE',
      'Leaving encrypted projects is unavailable until the database is updated.'
    );
  }
  const epoch = uintField(body.epoch, 'epoch');
  const deviceId = idField(body.deviceId, 'deviceId');
  if (body.kind !== 'self-remove') invalid('kind must be self-remove');
  const message = bytesField(body.message, 'message', {
    max: MAX_PROPOSAL_BYTES
  });
  let frame;
  try {
    frame = parseSelfRemoveProposal(message.bytes);
  } catch {
    invalid('message must be an MLS SelfRemove proposal from a member');
  }
  if (
    !sameBytes(frame.groupId, projectGroupId(projectId)) ||
    frame.epoch !== epoch
  ) {
    invalid('message must be for this project’s group and the stated epoch');
  }
  await requireCertifiedDevice(db, userId, deviceId);
  const project = await db
    .prepare(
      `SELECT p.user_id,
         (SELECT m.role FROM project_members m
          WHERE m.project_id = p.id AND m.user_id = ?) AS member_role
       FROM projects p WHERE p.id = ?`
    )
    .bind(userId, projectId)
    .first<{ user_id: string; member_role: string | null }>();
  if (project?.user_id === userId) {
    refuse(
      409,
      'E2EE_OWNER_CANNOT_LEAVE',
      'The owner cannot leave an encrypted project.'
    );
  }
  if (project?.member_role !== 'editor' && project?.member_role !== 'viewer') {
    refuse(404, 'PROJECT_NOT_FOUND', 'Project not found.');
  }
  const group = await groupPosition(db, projectId);
  const stale = (current: GroupPosition): never =>
    refuse(
      409,
      'E2EE_EPOCH_STALE',
      `The group is at epoch ${current.epoch}; catch up and leave again.`,
      { epoch: current.epoch }
    );
  if (group.epoch !== epoch) stale(group);
  const keyEpoch = group.key_epoch_base + epoch;
  const hash = await sha256Hex(message.bytes);
  const now = new Date().toISOString();
  const event = removalEvent({ encrypted: true, left: true, epoch });
  const statements = [
    db
      .prepare(
        `INSERT INTO e2ee_mls_proposals
           (project_id, key_epoch, proposal_hash, kind, sender_user_id,
            sender_device_id, message, created_at)
         SELECT ?, ?, ?, 'self-remove', ?, ?, ?, ?
         WHERE ${authorization.sql} AND ${MEMBER_FENCE}
           AND NOT EXISTS (SELECT 1 FROM projects WHERE id = ? AND user_id = ?)
           AND EXISTS (SELECT 1 FROM e2ee_project_groups
                       WHERE project_id = ? AND epoch = ? AND key_epoch_base = ?)`
      )
      .bind(
        projectId,
        keyEpoch,
        hash,
        userId,
        deviceId,
        message.text,
        now,
        ...authorization.binds,
        ...fenceBinds(projectId, userId),
        projectId,
        userId,
        projectId,
        epoch,
        group.key_epoch_base
      ),
    db
      .prepare(
        `INSERT INTO project_access_events
           (project_id, actor_user_id, subject_user_id, event_type,
            previous_role, created_at, metadata_json)
         SELECT ?, ?, ?, 'member-removed', role, ?, ?
         FROM project_members
         WHERE project_id = ? AND user_id = ? AND ${CHAINED}`
      )
      .bind(
        projectId,
        userId,
        userId,
        Math.floor(Date.parse(now) / 1000),
        event.metadata,
        projectId,
        userId
      ),
    // Decision M4: the departing member's access goes now, not when
    // another member commits the departure.
    db
      .prepare(
        `DELETE FROM project_members
         WHERE project_id = ? AND user_id = ? AND ${CHAINED}`
      )
      .bind(projectId, userId)
  ];
  const chained = statements.length;
  statements.push(
    ...(await accessCleanupStatements(
      db,
      projectId,
      userId,
      event.landedSql,
      event.landedBinds(projectId, userId)
    ))
  );
  const results = await runBatch(db, statements);
  if (!allLanded(results, chained)) {
    const current = await groupPosition(db, projectId);
    if (current.epoch !== epoch) stale(current);
    refuse(
      401,
      'E2EE_SESSION_REQUIRED',
      'Sign in again before changing encryption keys.'
    );
  }
  return json(
    {
      proposal: proposalRecord({
        key_epoch: keyEpoch,
        proposal_hash: hash,
        kind: 'self-remove',
        sender_user_id: userId,
        sender_device_id: deviceId,
        message: message.text,
        created_at: now
      })
    } satisfies E2eeMlsProposalResponse,
    201
  );
}

const allLanded = (results: readonly BatchResult[], count: number) =>
  results.length >= count &&
  results.slice(0, count).every((result) => (result.meta?.changes ?? 0) === 1);

// --- Settling pending proposals in a Commit ----------------------------------

function hashList(value: unknown, what: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_SETTLED) {
    invalid(`${what} must list at most ${MAX_SETTLED} proposal hashes`);
  }
  for (const hash of value) {
    if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) {
      invalid(`${what} must list SHA-256 hex hashes`);
    }
  }
  return value as string[];
}

/** What settling the epoch's pending proposals adds to a Commit's batch. */
export interface PreparedSettlement {
  /** ANDed into the Commit row's own insert, which gates the batch. */
  readonly gateSql: string;
  readonly gateBinds: readonly unknown[];
  /** The proposals the Commit applies. */
  readonly applied: readonly string[];
  /** Chained after the rest of the Commit's batch (each changes one row). */
  chained(): D1PreparedStatement[];
}

/**
 * Checks that a Commit for MLS `epoch` settles exactly the proposals still
 * pending in its key epoch (409 `E2EE_PROPOSALS_PENDING` otherwise), and
 * returns what its batch needs to mark them settled. An external Commit is
 * refused while one is pending (409 `E2EE_DEPARTURE_PENDING`).
 */
export async function prepareProposalSettlement(
  db: D1Database,
  input: {
    readonly projectId: string;
    readonly epoch: number;
    readonly keyEpochBase: number;
    readonly kind: 'commit' | 'external';
    readonly proposals: unknown;
    readonly rejectedProposals: unknown;
  }
): Promise<PreparedSettlement> {
  const { projectId } = input;
  const applied = hashList(input.proposals, 'proposals');
  const rejected = hashList(input.rejectedProposals, 'rejectedProposals');
  const stated = [...applied, ...rejected];
  if (new Set(stated).size !== stated.length) {
    invalid('A proposal is settled twice');
  }
  if (!(await isE2eeMlsProposalStorageReady(db))) {
    if (stated.length) {
      refuse(
        503,
        'E2EE_UNAVAILABLE',
        'Stored proposals are unavailable until the database is updated.'
      );
    }
    return { gateSql: '', gateBinds: [], applied: [], chained: () => [] };
  }
  const keyEpoch = input.keyEpochBase + input.epoch;
  const { results } = await db
    .prepare(
      `SELECT proposal_hash FROM e2ee_mls_proposals
       WHERE project_id = ? AND key_epoch = ? AND outcome IS NULL`
    )
    .bind(projectId, keyEpoch)
    .all<{ proposal_hash: string }>();
  const pending = new Set((results ?? []).map((row) => row.proposal_hash));
  if (input.kind === 'external') {
    if (stated.length) invalid('An external Commit settles no proposals');
    if (pending.size) {
      refuse(
        409,
        'E2EE_DEPARTURE_PENDING',
        'A member’s departure must be committed by another member before this device can rejoin.'
      );
    }
  } else if (
    pending.size !== stated.length ||
    stated.some((hash) => !pending.has(hash))
  ) {
    refuse(
      409,
      'E2EE_PROPOSALS_PENDING',
      'This Commit does not settle the proposals pending in its epoch. Process them and try again.',
      { pending: [...pending] }
    );
  }
  const pendingCount = `(SELECT COUNT(*) FROM e2ee_mls_proposals
    WHERE project_id = ? AND key_epoch = ? AND outcome IS NULL`;
  const gateSql = stated.length
    ? `${pendingCount}) = ? AND ${pendingCount}
        AND proposal_hash IN (${stated.map(() => '?').join(', ')})) = ?`
    : `${pendingCount}) = 0`;
  const gateBinds = stated.length
    ? [
        projectId,
        keyEpoch,
        stated.length,
        projectId,
        keyEpoch,
        ...stated,
        stated.length
      ]
    : [projectId, keyEpoch];
  const settle = (hash: string, outcome: 'committed' | 'rejected') =>
    db
      .prepare(
        `UPDATE e2ee_mls_proposals SET outcome = ?, settled_key_epoch = ?
         WHERE project_id = ? AND key_epoch = ? AND proposal_hash = ?
           AND outcome IS NULL AND ${CHAINED}`
      )
      .bind(outcome, keyEpoch + 1, projectId, keyEpoch, hash);
  return {
    gateSql,
    gateBinds,
    applied,
    chained: () => [
      ...applied.map((hash) => settle(hash, 'committed')),
      ...rejected.map((hash) => settle(hash, 'rejected'))
    ]
  };
}

/**
 * Account erasure (migration 0039): with `all`, proposals the account sent
 * in other owners' projects keep their bytes (members may still need to
 * commit them) but lose the sender, as Commits do. Empty until the table
 * exists.
 */
export async function proposalErasureStatements(
  db: D1Database,
  userId: string,
  scope: 'profile' | 'all'
): Promise<D1PreparedStatement[]> {
  if (scope !== 'all' || !(await isE2eeMlsProposalStorageReady(db))) return [];
  return [
    db
      .prepare(
        `UPDATE e2ee_mls_proposals
         SET sender_user_id = NULL, sender_device_id = NULL
         WHERE sender_user_id = ?`
      )
      .bind(userId)
  ];
}
