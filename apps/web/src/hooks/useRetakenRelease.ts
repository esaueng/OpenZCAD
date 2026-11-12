import { useRef } from 'react';
import type { ProjectDocument } from '@openzcad/shared';
import type {
  DirectEditCommit,
  SupersededDirectEdit
} from './useDirectEditCommit';

/** The handles whose validating release the hand may take again. */
export type RetakeableOp = 'offset-face' | 'resize-cylinder-radius';

/** The face a retaken handle belongs to. */
export interface RetakenTarget {
  bodyId: string;
  topologyId: string;
}

/** What the interaction is doing now, as far as a retaken drag cares. */
export interface RetakenInteraction {
  mode: string;
  op?: string;
  phase?: string;
  target?: RetakenTarget;
}

export const RETAKEN_DOCUMENT_CHANGED =
  'The document changed while the edit was validating.';
export const RETAKEN_EDIT_BUSY =
  'Another edit was still being checked, so the earlier release was not applied.';

export interface RetakenReleaseHost {
  directEdit: Pick<DirectEditCommit, 'run' | 'supersede' | 'discard' | 'idle'>;
  /** The live document, the one a set-aside release must still be based on. */
  document(): ProjectDocument | null | undefined;
  onStatus(message: string): void;
}

export interface RetakenRelease {
  /**
   * The hand pressed `op`'s handle while its release validates: sets that
   * release aside (`useDirectEditCommit` `supersede`) for the drag that
   * follows. False when there was nothing to set aside.
   */
  retake(op: RetakeableOp, target: RetakenTarget): boolean;
  /** Whether a drag of `op` holds a set-aside release. */
  holds(op: RetakeableOp): boolean;
  /**
   * Hands over the release `op`'s drag set aside, if it still applies to
   * the live document. Consumed either way: a drag ends once. A release the
   * document moved on from is dropped and reported, as a validating one is.
   */
  take(op: RetakeableOp): SupersededDirectEdit | null;
  /** Commits a taken release as it was let go, from its own rebuild. */
  commit(edit: SupersededDirectEdit): boolean;
  /**
   * The drag ended without an edit of its own (abandoned, refused or
   * blocked): its set-aside release lands as it was let go. True when one
   * does, so the viewport keeps showing it at the let-go value.
   */
  land(op: RetakeableOp): boolean;
  /** The drag ended back on the original value: its release is dropped. */
  drop(op: RetakeableOp): void;
  /**
   * Follows the live interaction and document. A drag that ended without
   * telling (the selection or tool changed under it) lands its release; a
   * document that moved on drops it with a report; another project drops it
   * silently.
   */
  follow(interaction: RetakenInteraction): void;
}

/**
 * The release a drag set aside by taking its handle again while it
 * validated, from that press until the drag ends. Exactly one way out is
 * taken: a commit of the new value (`take`), the set-aside release landing
 * as it was let go (`land`), or dropping it (`drop`, or a document that
 * moved on). Nothing of it reached the document before then.
 */
export function useRetakenRelease(host: RetakenReleaseHost): RetakenRelease {
  // One stable object: it reads the latest host through `hostRef`.
  const hostRef = useRef(host);
  hostRef.current = host;
  const held = useRef<{
    edit: SupersededDirectEdit;
    op: RetakeableOp;
    target: RetakenTarget;
  } | null>(null);

  function take(op: RetakeableOp): SupersededDirectEdit | null {
    const retaken = held.current;
    if (!retaken || retaken.op !== op) return null;
    held.current = null;
    const { directEdit, document, onStatus } = hostRef.current;
    const base = document();
    const { baseProjectId, baseVersion } = retaken.edit.precomputed;
    if (base?.projectId === baseProjectId && base.version === baseVersion)
      return retaken.edit;
    directEdit.discard();
    // Another project: nothing to report there.
    if (base?.projectId === baseProjectId) onStatus(RETAKEN_DOCUMENT_CHANGED);
    return null;
  }

  function commit(edit: SupersededDirectEdit): boolean {
    const { directEdit, onStatus } = hostRef.current;
    if (!directEdit.idle()) {
      directEdit.discard();
      onStatus(RETAKEN_EDIT_BUSY);
      return false;
    }
    void directEdit.run(
      edit.command,
      edit.targetBodyId,
      edit.successMessage,
      edit.submittedValue,
      edit.onSuccess,
      edit.validationTargets,
      edit.precomputed
    );
    return true;
  }

  function land(op: RetakeableOp): boolean {
    const edit = take(op);
    return edit ? commit(edit) : false;
  }

  const api = useRef<RetakenRelease | null>(null);
  api.current ??= {
    retake(op, target) {
      const edit = hostRef.current.directEdit.supersede();
      if (!edit) return false;
      held.current = {
        edit,
        op,
        target: { bodyId: target.bodyId, topologyId: target.topologyId }
      };
      return true;
    },
    holds(op) {
      return held.current?.op === op;
    },
    take,
    commit,
    land,
    drop(op) {
      if (take(op)) hostRef.current.directEdit.discard();
    },
    follow(interaction) {
      const retaken = held.current;
      if (!retaken) return;
      const base = hostRef.current.document();
      const { baseProjectId, baseVersion } = retaken.edit.precomputed;
      if (base?.projectId !== baseProjectId || base.version !== baseVersion) {
        take(retaken.op);
        return;
      }
      const sameDrag =
        interaction.mode === 'face' &&
        interaction.op === retaken.op &&
        interaction.target?.bodyId === retaken.target.bodyId &&
        interaction.target.topologyId === retaken.target.topologyId &&
        // `validating` only until the retake's own `drag-retake` lands.
        (interaction.phase === 'dragging' ||
          interaction.phase === 'validating');
      if (!sameDrag) land(retaken.op);
    }
  };
  return api.current;
}
