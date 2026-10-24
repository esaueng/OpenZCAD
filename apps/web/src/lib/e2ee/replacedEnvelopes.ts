/**
 * Encrypted measurements and view state in the browser (ADR-024 Phase 4,
 * slice 4-7; roadmap L11). Both are small signed project envelopes the
 * account replaces as a whole (`/api/e2ee/projects/:id/measurements` and
 * `…/view-states`), sealed and opened through the encrypted project store's
 * kit (`EncryptedProjectStore.replaced`): under the project's current key
 * epoch, bound to it, signed by this device's certified signing key, and on
 * the way back checked against the signer, the epoch binding, the kind,
 * project and version, then read by the kind's body codec in the decode
 * worker and checked by the app's own validators.
 *
 * - **Measurements.** The revision is plaintext (the Worker fences on it),
 *   each envelope names the hash of the one it replaces, and this browser
 *   pins the newest revision and hash it accepted: an older revision, or
 *   another envelope at the pinned one, is refused as a rollback or fork
 *   and never written over. An envelope that does not verify (a signer this
 *   account no longer lists, a broken body) reads as no measurements, so the
 *   device copy replaces it on the next sync, chained on its bytes.
 * - **View state.** One envelope per workspace session of this user, its
 *   sequence plaintext and pinned per session. A session that does not
 *   verify, or that the account rolled back, is left out of the resume
 *   offer: it is a convenience, never a reason to stop.
 */
import {
  encodeMeasurementsBody,
  encodeViewStateBody,
  fromBase64Url,
  toHex,
  versionHash,
  type BodyEnvelopeHeader,
  type MeasurementsBody,
  type ProjectEnvelopeHeader,
  type ViewStateBody
} from '@openzcad/crypto';
import {
  E2EE_MEASUREMENT_CONFLICT_CODE,
  parseWorkspaceResumeState,
  type E2eeMeasurementsResponse,
  type E2eeMeasurementsUpload,
  type E2eeProjectEnvelopeRecord,
  type E2eeReplacedEnvelopeKind,
  type E2eeViewStateUpload,
  type E2eeViewStatesResponse,
  type ProjectWorkspaceSession
} from '@openzcad/shared';
import { ApiError } from '../api';
import { desktopFetch } from '../desktopBridge';
import type { StoredMeasurementRecord } from '../measurementRecord';
import { parseStoredMeasurements } from '../measurementStore';
import type { ProjectEnvelopeBody } from './decodeJobs';
import { envelopeMayFollow, type VersionPinStore } from './versionPins';

// --- The store's kit ----------------------------------------------------------

/** A replaced envelope sealed for upload, with what to pin once stored. */
export interface SealedReplaced {
  readonly envelope: string;
  readonly wrappedVersionKey: string;
  readonly signature: string;
  readonly signerDeviceId: string;
  /** Lowercase hex version hash of the envelope. */
  readonly hash: string;
  readonly keyEpoch: number;
}

/** A replaced envelope that verified and decoded. */
export interface OpenedReplaced {
  readonly header: ProjectEnvelopeHeader;
  readonly value: ProjectEnvelopeBody;
  readonly hash: string;
  /** The signer's timestamp, Unix ms. */
  readonly signedAt: number;
}

/** What the encrypted project store lends replaced envelopes. */
export interface ReplacedEnvelopeKit {
  /**
   * Encodes, encrypts, binds and signs one replaced envelope under the
   * project's current key epoch (catching the group up first).
   */
  seal(
    projectId: string,
    init: {
      readonly kind: E2eeReplacedEnvelopeKind;
      readonly sequence: number;
      readonly previousHash: string | null;
      readonly blobIds: readonly string[];
    },
    encode: (header: BodyEnvelopeHeader) => Uint8Array
  ): Promise<SealedReplaced>;
  /**
   * Verifies one stored replaced envelope (signer, epoch binding, kind,
   * project, sequence and key epoch) and decodes its body. Refusals are
   * `EncryptedProjectIntegrityError`s.
   */
  open(
    record: E2eeProjectEnvelopeRecord,
    kind: E2eeReplacedEnvelopeKind
  ): Promise<OpenedReplaced>;
}

/** Lowercase hex version hash of a stored envelope's bytes. */
export async function storedEnvelopeHash(envelope: string): Promise<string> {
  return toHex(await versionHash(fromBase64Url(envelope)));
}

const STALE_EPOCH = 'E2EE_EPOCH_STALE';
const isStaleEpoch = (error: unknown) =>
  error instanceof ApiError && error.code === STALE_EPOCH;

// --- Routes ---------------------------------------------------------------------

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface ReplacedEnvelopesApi {
  measurements(projectId: string): Promise<E2eeMeasurementsResponse>;
  saveMeasurements(
    projectId: string,
    upload: E2eeMeasurementsUpload
  ): Promise<E2eeMeasurementsResponse>;
  viewStates(projectId: string): Promise<E2eeViewStatesResponse>;
  saveViewState(
    projectId: string,
    sessionId: string,
    upload: E2eeViewStateUpload
  ): Promise<void>;
}

async function refusal(response: Response): Promise<ApiError> {
  const text = await response.text().catch(() => '');
  let details: Record<string, unknown> | undefined;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object') {
      details = parsed as Record<string, unknown>;
    }
  } catch {
    // A static host answers unknown routes with HTML.
  }
  return new ApiError(
    response.status,
    typeof details?.error === 'string'
      ? details.error
      : `${response.status} ${response.statusText}`,
    typeof details?.code === 'string' ? details.code : undefined,
    details
  );
}

export function createReplacedEnvelopesApi(
  fetcher: Fetch = desktopFetch
): ReplacedEnvelopesApi {
  const base = (projectId: string) =>
    `/api/e2ee/projects/${encodeURIComponent(projectId)}`;
  const send = async (path: string, init: RequestInit = {}) => {
    const response = await fetcher(path, {
      credentials: 'same-origin',
      ...init,
      headers: {
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(init.headers as Record<string, string> | undefined)
      }
    });
    if (!response.ok) throw await refusal(response);
    return response;
  };
  return {
    measurements: async (projectId) =>
      (await (
        await send(`${base(projectId)}/measurements`)
      ).json()) as E2eeMeasurementsResponse,
    saveMeasurements: async (projectId, upload) =>
      (await (
        await send(`${base(projectId)}/measurements`, {
          method: 'PUT',
          body: JSON.stringify(upload)
        })
      ).json()) as E2eeMeasurementsResponse,
    viewStates: async (projectId) =>
      (await (
        await send(`${base(projectId)}/view-states`)
      ).json()) as E2eeViewStatesResponse,
    saveViewState: async (projectId, sessionId, upload) => {
      await send(
        `${base(projectId)}/view-states/${encodeURIComponent(sessionId)}`,
        { method: 'PUT', body: JSON.stringify(upload) }
      );
    }
  };
}

interface ReplacedDeps {
  readonly userId: string;
  readonly kit: ReplacedEnvelopeKit;
  readonly pins: VersionPinStore;
  readonly api?: ReplacedEnvelopesApi;
}

/** A replaced envelope the account offered below or beside this browser's pin. */
export class ReplacedEnvelopeRollbackError extends ApiError {
  constructor(what: string) {
    super(
      503,
      `The account offered older ${what} than this browser already accepted. The copy on this device is kept.`,
      'E2EE_ENVELOPE_ROLLBACK'
    );
    this.name = 'ReplacedEnvelopeRollbackError';
  }
}

// --- Measurements -----------------------------------------------------------------

const MEASUREMENTS_PIN = 'measurements';

export interface EncryptedMeasurementSnapshot {
  revision: number;
  record: StoredMeasurementRecord | null;
}

export interface EncryptedMeasurements {
  loadProjectMeasurements(
    projectId: string
  ): Promise<EncryptedMeasurementSnapshot>;
  saveProjectMeasurements(input: {
    projectId: string;
    expectedRevision: number;
    record: StoredMeasurementRecord;
  }): Promise<EncryptedMeasurementSnapshot>;
}

/** The measurements client with the plaintext client's shapes. */
export function createEncryptedMeasurements(
  deps: ReplacedDeps
): EncryptedMeasurements {
  const api = deps.api ?? createReplacedEnvelopesApi();
  const { userId, kit, pins } = deps;
  /** The revision and hash this page last read or wrote, per project. */
  const seen = new Map<string, { revision: number; hash: string | null }>();

  async function load(
    projectId: string
  ): Promise<EncryptedMeasurementSnapshot> {
    const { revision, measurements } = await api.measurements(projectId);
    const pinned =
      (await pins.read(userId, projectId))?.envelopes[MEASUREMENTS_PIN] ?? null;
    if (!measurements) {
      if (pinned && pinned.sequence > 0) {
        throw new ReplacedEnvelopeRollbackError('measurements');
      }
      seen.set(projectId, { revision: 0, hash: null });
      return { revision: 0, record: null };
    }
    if (
      measurements.projectId !== projectId ||
      measurements.sequence !== revision
    ) {
      throw new ApiError(502, 'The account answered with other measurements.');
    }
    const hash = await storedEnvelopeHash(measurements.envelope);
    if (!envelopeMayFollow(pinned, revision, hash)) {
      throw new ReplacedEnvelopeRollbackError('measurements');
    }
    seen.set(projectId, { revision, hash });
    let record: StoredMeasurementRecord | null = null;
    try {
      const opened = await kit.open(measurements, 'measurements');
      const parsed = parseStoredMeasurements(
        (opened.value as MeasurementsBody).record
      );
      if (parsed && parsed.projectId === projectId) record = parsed;
    } catch {
      // Unverifiable: no measurements here; the device copy replaces it.
    }
    if (record) {
      await pins.advanceEnvelope(userId, projectId, MEASUREMENTS_PIN, {
        sequence: revision,
        hash
      });
    }
    return { revision, record };
  }

  return {
    loadProjectMeasurements: load,
    async saveProjectMeasurements({ projectId, expectedRevision, record }) {
      if (record.projectId !== projectId) {
        throw new ApiError(400, 'Measurements belong to another project.');
      }
      let base = seen.get(projectId);
      if (!base || base.revision !== expectedRevision) {
        await load(projectId);
        base = seen.get(projectId);
      }
      if (!base || base.revision !== expectedRevision) {
        throw new ApiError(
          409,
          `Project measurements are at revision ${base?.revision ?? 0}.`,
          E2EE_MEASUREMENT_CONFLICT_CODE,
          { currentRevision: base?.revision ?? 0 }
        );
      }
      for (let attempt = 0; ; attempt++) {
        const sealed = await kit.seal(
          projectId,
          {
            kind: 'measurements',
            sequence: expectedRevision + 1,
            previousHash: base.hash,
            blobIds: []
          },
          (header) =>
            encodeMeasurementsBody(
              { record: record as unknown as Record<string, unknown> },
              header
            )
        );
        let saved: E2eeMeasurementsResponse;
        try {
          saved = await api.saveMeasurements(projectId, {
            expectedRevision,
            envelope: sealed.envelope,
            wrappedVersionKey: sealed.wrappedVersionKey,
            signature: sealed.signature,
            signerDeviceId: sealed.signerDeviceId
          });
        } catch (error) {
          if (isStaleEpoch(error) && attempt < 2) continue;
          if (
            error instanceof ApiError &&
            error.code === E2EE_MEASUREMENT_CONFLICT_CODE
          ) {
            seen.delete(projectId);
          }
          throw error;
        }
        if (
          saved.revision !== expectedRevision + 1 ||
          saved.measurements?.envelope !== sealed.envelope
        ) {
          throw new ApiError(
            502,
            'The account stored other measurements than this browser sent.'
          );
        }
        seen.set(projectId, { revision: saved.revision, hash: sealed.hash });
        await pins.advanceEnvelope(userId, projectId, MEASUREMENTS_PIN, {
          sequence: saved.revision,
          hash: sealed.hash
        });
        return { revision: saved.revision, record };
      }
    }
  };
}

// --- View state -------------------------------------------------------------------

const viewStatePin = (sessionId: string) => `view-state:${sessionId}`;
const WORKSPACE_ID = /^[a-zA-Z0-9_-]{1,80}$/;

/** The session a view-state body carries, checked as the Worker checks plaintext. */
export function parseEncryptedWorkspaceSession(
  value: unknown,
  record: { projectId: string; sessionId: string; sequence: number }
): Omit<ProjectWorkspaceSession, 'updatedAt'> | null {
  const input = value as Partial<ProjectWorkspaceSession> | null;
  const state = parseWorkspaceResumeState(input?.state);
  if (
    !input ||
    !state ||
    input.schemaVersion !== 1 ||
    input.projectId !== record.projectId ||
    input.sessionId !== record.sessionId ||
    input.sequence !== record.sequence ||
    !WORKSPACE_ID.test(input.deviceId ?? '') ||
    !['Desktop', 'Mobile'].includes(input.deviceLabel ?? '') ||
    !Number.isSafeInteger(input.documentVersion) ||
    Number(input.documentVersion) < 1
  ) {
    return null;
  }
  return {
    schemaVersion: 1,
    projectId: record.projectId,
    deviceId: input.deviceId!,
    sessionId: record.sessionId,
    deviceLabel: input.deviceLabel!,
    sequence: record.sequence,
    documentVersion: input.documentVersion!,
    state
  };
}

export interface EncryptedViewStates {
  load(projectId: string): Promise<ProjectWorkspaceSession[]>;
  save(session: Omit<ProjectWorkspaceSession, 'updatedAt'>): Promise<void>;
}

/** The workspace-session client with the plaintext client's shapes. */
export function createEncryptedViewStates(
  deps: ReplacedDeps
): EncryptedViewStates {
  const api = deps.api ?? createReplacedEnvelopesApi();
  const { userId, kit, pins } = deps;
  return {
    async load(projectId) {
      const { sessions } = await api.viewStates(projectId);
      const pin = await pins.read(userId, projectId);
      const opened: ProjectWorkspaceSession[] = [];
      for (const record of sessions) {
        if (record.projectId !== projectId) continue;
        try {
          const hash = await storedEnvelopeHash(record.envelope);
          const key = viewStatePin(record.sessionId);
          if (
            !envelopeMayFollow(
              pin?.envelopes[key] ?? null,
              record.sequence,
              hash
            )
          ) {
            continue;
          }
          const { value } = await kit.open(record, 'view-state');
          const session = parseEncryptedWorkspaceSession(
            (value as ViewStateBody).session,
            {
              projectId,
              sessionId: record.sessionId,
              sequence: record.sequence
            }
          );
          if (!session) continue;
          await pins.advanceEnvelope(userId, projectId, key, {
            sequence: record.sequence,
            hash
          });
          opened.push({ ...session, updatedAt: record.updatedAt });
        } catch {
          // Left out of the resume offer.
        }
      }
      return opened;
    },
    async save(session) {
      for (let attempt = 0; ; attempt++) {
        const sealed = await kit.seal(
          session.projectId,
          {
            kind: 'view-state',
            sequence: session.sequence,
            previousHash: null,
            blobIds: []
          },
          (header) => encodeViewStateBody({ session }, header)
        );
        try {
          await api.saveViewState(session.projectId, session.sessionId, {
            sequence: session.sequence,
            documentVersion: session.documentVersion,
            envelope: sealed.envelope,
            wrappedVersionKey: sealed.wrappedVersionKey,
            signature: sealed.signature,
            signerDeviceId: sealed.signerDeviceId
          });
        } catch (error) {
          if (isStaleEpoch(error) && attempt < 2) continue;
          throw error;
        }
        await pins.advanceEnvelope(
          userId,
          session.projectId,
          viewStatePin(session.sessionId),
          { sequence: session.sequence, hash: sealed.hash }
        );
        return;
      }
    }
  };
}
