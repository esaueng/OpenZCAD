import { Scissors } from 'lucide-react';
import { FACE_OFFSET_SECTION_NOTE } from '../lib/faceOffsetSectionVisibility';

export interface SectionHidesEditNoticeProps {
  /** Turns the section view off, which shows the whole face again. */
  onTurnOff(): void;
}

/**
 * The command bar's note while an active section view hides part of the
 * face being offset or its preview: what is hidden, and the way to see it.
 * Shown only then; a cut that keeps the whole edit in view says nothing.
 */
export function SectionHidesEditNotice({
  onTurnOff
}: SectionHidesEditNoticeProps) {
  return (
    <div className="section-hidden-notice" role="note">
      <span className="section-hidden-notice-line">
        <Scissors size={14} aria-hidden="true" />
        <strong>{FACE_OFFSET_SECTION_NOTE}</strong>
        <span className="section-hidden-notice-detail">
          Turn the section view off to see the whole edit.
        </span>
      </span>
      <button type="button" className="edit-refusal-action" onClick={onTurnOff}>
        Turn off section
      </button>
    </div>
  );
}
