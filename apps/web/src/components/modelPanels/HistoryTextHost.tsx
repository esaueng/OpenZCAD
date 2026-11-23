import { Suspense } from 'react';
import { createPortal } from 'react-dom';
import type { CadPatchProposal } from '@openzcad/ai-contracts';
import type { ProjectDocument } from '@openzcad/shared';
import { lazyWithStaleChunkNotice } from '../../lib/staleChunk';
import type { PatchSource } from './modelPanelProps';
import type { HistoryTextView } from './panelViews';
import { historyTextToggle } from './HistoryPanel';

/** L15: loaded with the scripting package only when it is first opened. */
const HistoryTextDialog = lazyWithStaleChunkNotice(
  () => import('../HistoryTextDialog')
);

export interface HistoryTextHostProps {
  view: HistoryTextView;
  document: ProjectDocument | null | undefined;
  /**
   * Why the history text cannot be applied right now (View mode, a viewer's
   * seat, …), or null when it can.
   */
  editBlocked?: string | null;
  /**
   * Checks an edited history text's proposal on the exact kernel and commits
   * it as one undo step, refusing a text printed from another version.
   * Absent, the history text is read only.
   */
  onApply?(proposal: CadPatchProposal, source: PatchSource): Promise<boolean>;
}

/**
 * History as text, drawn once for the workspace rather than by the History
 * panel. The desktop dock and the phone lane each mount their own History
 * panel, so a dialog the panel drew closed, and dropped its unapplied edit,
 * whenever the window crossed the phone breakpoint. Its open state and edit
 * live in `view`, held with the other panel view state.
 */
export function HistoryTextHost({
  view,
  document,
  editBlocked = null,
  onApply
}: HistoryTextHostProps) {
  if (!view.open || !document) return null;
  return createPortal(
    <Suspense fallback={null}>
      <HistoryTextDialog
        document={document}
        editBlocked={editBlocked}
        {...(onApply ? { onApply } : {})}
        session={view}
        returnFocus={historyTextToggle}
        onClose={view.close}
      />
    </Suspense>,
    window.document.body
  );
}
