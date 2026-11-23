import {
  appendRevision,
  createCheckpoint,
  estimateUnitsConvertUndo,
  runUnitsConversion,
  unitsConvertCheckpointName,
  unitsConvertUndoRefusal,
  type UnitsConvertRefusal
} from '@openzcad/document-core';
import {
  commandFactories,
  type CommandManager
} from '@openzcad/command-system';
import type { UnitsConversionPreparation } from '@openzcad/kernel-adapter/exact';
import type {
  CollaborationMember,
  ProjectAccessRole,
  ProjectDocument,
  ProjectEditLease
} from '@openzcad/shared';
import { saveLocalProject, saveLocalSaveStates } from './localProjectStore';
import type { CollaborationStatus } from './useCollaboration';

/**
 * I03 stored-unit conversion, phase 5 (plan §5.1–§5.3): applying a prepared
 * `units.convert` in the workspace. The kernel checks run first, off the
 * main thread (`prepareUnitsConversionInWorker`); this module then refuses
 * while other people could be editing, writes and persists the safety
 * checkpoint exactly as a save-state restore does
 * (`prepareSaveStateRestore`), and submits the command as one undo step.
 *
 * The review dialog (phase 6) calls these two functions; nothing in the
 * workspace calls them yet.
 */

export type PreparedUnitsConversion = Extract<
  UnitsConversionPreparation,
  { ok: true }
>;

/** What the workspace knows about the live room, if the project has one. */
export interface UnitsConversionCollaborationState {
  /** Whether the project syncs through a collaboration room at all. */
  enabled: boolean;
  status: CollaborationStatus;
  role: ProjectAccessRole | null;
  /** The edit lease this browser holds, if any. */
  lease: ProjectEditLease | null;
  members: readonly CollaborationMember[];
  /** This browser's collaboration client id. */
  clientId: string;
}

/**
 * Why a stored-unit conversion must wait for the room, or null when it may
 * run (plan §5.5, an inferred requirement checked against ADR-007/ADR-019).
 *
 * A conversion rewrites nearly every stored value in one edit, so an edit
 * another person makes meanwhile would be written in the old unit into a
 * converted document, or conflict wholesale. The room has no exclusive
 * project lock to take: a per-browser edit lease (ADR-007), enforced by a
 * rollout flag the client cannot read, and presence. So the conversion
 * requires:
 *
 * - an editing role (never a viewer);
 * - a live room (offline or reconnecting, presence cannot be trusted);
 * - the edit lease, when one was granted, still unexpired, and not refused
 *   (`lease-denied` means another browser holds it);
 * - no other live member, idle or active, including this account in
 *   another tab: presence is the only way to know nobody else will write.
 *
 * A project without a room (local, or an account project not shared) has
 * no one else to wait for.
 */
export function unitsConversionCollaborationRefusal(
  state: UnitsConversionCollaborationState | null | undefined,
  now = Date.now()
): UnitsConvertRefusal | null {
  if (!state?.enabled) return null;
  const refuse = (code: string, message: string): UnitsConvertRefusal => ({
    stage: 'collaboration',
    code,
    subject: 'document',
    message
  });
  if (state.role === 'viewer')
    return refuse(
      'viewer',
      'You can view this project but not edit it, so you cannot convert its stored units.'
    );
  if (state.status === 'lease-denied')
    return refuse(
      'editor-lock',
      'Someone else is editing this project. Convert stored units once you hold the edit lock.'
    );
  if (state.status !== 'live')
    return refuse(
      'not-live',
      'Converting stored units needs the live session, so it can check nobody else is editing. Reconnect and try again.'
    );
  if (
    state.lease &&
    (state.lease.clientId !== state.clientId || state.lease.expiresAt <= now)
  )
    return refuse(
      'editor-lock',
      'This browser’s edit lock has expired. Wait for it to renew and try again.'
    );
  const others = state.members.filter(
    (member) => member.clientId !== state.clientId
  );
  if (others.length > 0) {
    const names = [...new Set(others.map((member) => member.displayName))];
    return refuse(
      'other-editors',
      `${names.join(', ')} ${names.length === 1 ? 'has' : 'have'} this project open. Converting stored units rewrites nearly every value at once, so ask ${names.length === 1 ? 'them' : 'everyone else'} to close it (other tabs of yours count too) and try again.`
    );
  }
  return null;
}

/** Where the safety checkpoint is written; the device store by default. */
export interface UnitsConversionPersistence {
  saveProject(document: ProjectDocument): Promise<void>;
  saveSaveStates(documents: readonly ProjectDocument[]): Promise<void>;
}

const DEVICE_STORE: UnitsConversionPersistence = {
  saveProject: saveLocalProject,
  saveSaveStates: saveLocalSaveStates
};

export interface CommitUnitsConversionOptions {
  /**
   * The project's save points live on this device only (a member editing
   * through the room), as for a restore: the checkpoint is kept as a local
   * save state and never advertised in the shared document.
   */
  deviceOnlyHistory?: boolean;
  /**
   * The live room, or a function that reads it. Pass the function (reading
   * the workspace's latest state): eligibility is checked again after the
   * checkpoint is persisted, and a snapshot taken before that write cannot
   * see a tab that joined, or a lease that expired, meanwhile.
   */
  collaboration?:
    | UnitsConversionCollaborationState
    | null
    | (() => UnitsConversionCollaborationState | null | undefined);
  persistence?: UnitsConversionPersistence;
  /** The clock eligibility is judged by; `Date.now` by default. */
  now?: number | (() => number);
}

export type CommitUnitsConversionResult =
  | {
      ok: true;
      /** The manager's document: converted, with its one undo entry. */
      document: ProjectDocument;
      /** The persisted pre-conversion document the checkpoint names. */
      checkpoint: ProjectDocument;
    }
  | {
      ok: false;
      refusals: UnitsConvertRefusal[];
      /**
       * Set when the refusal came after the safety checkpoint was persisted
       * (eligibility changed while it was written). The checkpoint stays
       * where it was saved: it names the current, unconverted document, so
       * keeping it is harmless and restoring it changes nothing.
       */
      checkpoint?: ProjectDocument;
    };

/**
 * Applies a prepared conversion to the workspace's active document (plan
 * §5.2, §5.3):
 *
 * 1. refuses while others could edit ({@link unitsConversionCollaborationRefusal}),
 *    when the document moved since it was prepared, when the payload does
 *    not apply (checked without changing anything), or when the active
 *    manager's undo history could not keep the conversion's step
 *    (`undo-too-large`, measured for the manager's own actor and current
 *    history, not the actor preparation assumed);
 * 2. writes the checkpoint "Before unit conversion (mm → in)" on a fresh
 *    revision and persists it *before* applying, as a restore does, so the
 *    state being left is reachable past any undo depth;
 * 3. checks step 1 again once the checkpoint is persisted, synchronously
 *    and immediately before executing, with no await in between: the
 *    manager must still be the active one and still hold the document it
 *    was checked on, and a tab that joined, a lease that expired or an undo
 *    entry that no longer fits refuses the conversion (the result then
 *    names the checkpoint, which stays);
 * 4. executes `units.convert` through that manager: one undo step, one more
 *    revision, the version still monotonic.
 *
 * Caller contract (phase 6): pass `activeManager` as a live getter that
 * returns the manager the workspace edits *now* (in the app, read
 * `managerRef.current`), never a manager captured earlier. Remote
 * hydration and project switches replace that manager; a conversion whose
 * manager was replaced during the write is refused (`stale`) and nothing
 * is applied, so the caller re-runs preparation on the new document. Pass
 * `collaboration` and `now` as functions for the same reason. Apply the
 * returned document (persist, sync, rebuild) only when `ok` is true.
 *
 * A refusal at step 1 writes nothing. A failure persisting the checkpoint
 * throws before the command exists. The room's edit lease renews on its own
 * timer while connected; there is no lock to hold across the write, so the
 * second check is what closes the window.
 */
export async function commitUnitsConversion(
  activeManager: () => CommandManager | null | undefined,
  prepared: PreparedUnitsConversion,
  options: CommitUnitsConversionOptions = {}
): Promise<CommitUnitsConversionResult> {
  const stale = (message: string): UnitsConvertRefusal => ({
    stage: 'payload',
    code: 'stale',
    subject: 'document',
    message
  });
  const eligibility = () =>
    unitsConversionCollaborationRefusal(
      typeof options.collaboration === 'function'
        ? options.collaboration()
        : options.collaboration,
      typeof options.now === 'function'
        ? options.now()
        : (options.now ?? Date.now())
    );
  const manager = activeManager();
  if (!manager)
    return {
      ok: false,
      refusals: [
        stale(
          'No project is open to convert. Open it and check the conversion again.'
        )
      ]
    };
  const collaboration = eligibility();
  if (collaboration) return { ok: false, refusals: [collaboration] };
  const current = manager.document;
  if (current.version !== prepared.sourceVersion)
    return {
      ok: false,
      refusals: [
        stale(
          'The project changed after the conversion was checked. Check it again.'
        )
      ]
    };
  const dryRun = runUnitsConversion(current, prepared.payload);
  if (!dryRun.ok) return { ok: false, refusals: dryRun.refusals };

  const persistence = options.persistence ?? DEVICE_STORE;
  const name = unitsConvertCheckpointName(
    prepared.payload.from,
    prepared.payload.to
  );
  const guarded = createCheckpoint(appendRevision(current, name), name);
  // Device-only history keeps the shared document's save points as they
  // are; the checkpoint lives in this device's save states. `base` is the
  // document the command will execute on.
  const base = options.deviceOnlyHistory ? current : guarded;
  const converted = runUnitsConversion(base, prepared.payload);
  if (!converted.ok) return { ok: false, refusals: converted.refusals };
  // The undo entry as this manager will record it: its actor and its
  // history, which need not be what preparation measured.
  const undoRefusal = () => {
    const undo = estimateUnitsConvertUndo(
      base,
      prepared.payload,
      manager.actorUserId,
      converted.document
    );
    return undo.exceedsLimit ? unitsConvertUndoRefusal(undo) : null;
  };
  const tooLarge = undoRefusal();
  if (tooLarge) return { ok: false, refusals: [tooLarge] };

  if (options.deviceOnlyHistory) await persistence.saveSaveStates([guarded]);
  else await persistence.saveProject(guarded);
  // Everything step 1 checked, again, now that the write has finished.
  // Nothing below awaits, so nothing can change before the command runs.
  if (activeManager() !== manager || manager.document !== current)
    return {
      ok: false,
      checkpoint: guarded,
      refusals: [
        stale(
          'The project changed while the safety checkpoint was being saved. Check the conversion again.'
        )
      ]
    };
  const changed = eligibility();
  if (changed) return { ok: false, checkpoint: guarded, refusals: [changed] };
  const undoChanged = undoRefusal();
  if (undoChanged)
    return { ok: false, checkpoint: guarded, refusals: [undoChanged] };
  if (!options.deviceOnlyHistory) manager.document = guarded;
  const document = manager.execute(
    commandFactories.convertUnits(prepared.payload)
  );
  return { ok: true, document, checkpoint: guarded };
}
