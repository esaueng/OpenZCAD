import { useEffect, useMemo, useRef, useState } from 'react';
import { FileCode2 } from 'lucide-react';
import type { CadPatchProposal } from '@openzcad/ai-contracts';
import {
  compileHistoryEdit,
  printHistory,
  type HistoryEditResult,
  type HistoryTextDiagnostic
} from '@openzcad/scripting';
import type { ProjectDocument } from '@openzcad/shared';
import { useModalFocus } from '../lib/useModalFocus';
import { useKeyboardInset } from '../lib/keyboardInset';
import type { PatchSource } from './modelPanels/modelPanelProps';

export interface HistoryTextDialogProps {
  document: ProjectDocument;
  /** Why an edit cannot be applied now, or null. */
  editBlocked?: string | null;
  /**
   * Checks the proposal on the exact kernel and commits it as one undo step;
   * resolves false when it was refused (the app says why). Absent, the text
   * is read only.
   */
  onApply?(proposal: CadPatchProposal, source: PatchSource): Promise<boolean>;
  onClose(): void;
}

function print(document: ProjectDocument): {
  text: string;
  error: string | null;
} {
  try {
    return { text: printHistory(document), error: null };
  } catch (error) {
    return {
      text: '',
      error:
        error instanceof Error
          ? error.message
          : 'The history could not be printed.'
    };
  }
}

function where(diagnostic: HistoryTextDiagnostic): string {
  return `Line ${diagnostic.span.start.line}, column ${diagnostic.span.start.column}`;
}

/**
 * L15: the model's feature history as text. A projection of the open
 * document: while the text is unedited it is printed again whenever the
 * document changes, so an edit made in the app shows here at once. An edit
 * here is compiled into the same patch proposal the assistant submits,
 * checked on the exact kernel and committed as one undo step. Loaded on
 * demand with the scripting package, outside the entry bundle.
 */
export default function HistoryTextDialog({
  document,
  editBlocked = null,
  onApply,
  onClose
}: HistoryTextDialogProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const textRef = useRef<HTMLTextAreaElement | null>(null);
  const printed = useMemo(() => print(document), [document]);
  // The edit and the version it was printed from; null while unedited.
  const [draft, setDraft] = useState<{
    text: string;
    baseVersion: number;
  } | null>(null);
  const [checked, setChecked] = useState<HistoryEditResult | null>(null);
  const [status, setStatus] = useState('');
  const [applying, setApplying] = useState(false);
  useModalFocus(dialogRef, { autoFocus: true, initialFocusRef: textRef });
  // An on-screen keyboard shrinks the visual viewport, not 100dvh; the
  // dialog's height subtracts it so the actions stay above the keyboard.
  useKeyboardInset(dialogRef);

  const text = draft?.text ?? printed.text;
  const stale = draft !== null && draft.baseVersion !== document.version;
  const editable = Boolean(onApply) && printed.error === null;
  const lineCount = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);

  // A result belongs to the text it checked; any keystroke clears it.
  useEffect(() => setChecked(null), [text]);

  function check(): HistoryEditResult {
    const result = compileHistoryEdit(document, text);
    setChecked(result);
    const errors = result.diagnostics.filter(
      (diagnostic) => diagnostic.severity === 'error'
    ).length;
    setStatus(
      errors > 0
        ? `${errors} problem${errors === 1 ? '' : 's'} to fix before applying.`
        : result.proposal
          ? `${result.summary.length} change${result.summary.length === 1 ? '' : 's'} ready to apply.`
          : 'No changes.'
    );
    return result;
  }

  async function apply() {
    if (!onApply || !draft || stale) return;
    const result = check();
    if (!result.proposal) return;
    setApplying(true);
    setStatus('Checking against exact geometry…');
    try {
      const applied = await onApply(result.proposal, {
        label: 'Edit history text',
        action: 'edit the history text',
        checking: 'Checking the history text against exact geometry…',
        moved:
          'The model changed while the history text was checked. Reload the text and make the edit again.',
        baseVersion: draft.baseVersion
      });
      if (applied) {
        setDraft(null);
        setChecked(null);
        setStatus('Applied as one undo step.');
      } else {
        setStatus('Not applied. The status bar says why.');
      }
    } finally {
      setApplying(false);
    }
  }

  function focusDiagnostic(diagnostic: HistoryTextDiagnostic) {
    const field = textRef.current;
    if (!field) return;
    field.focus();
    field.setSelectionRange(
      diagnostic.span.start.offset,
      diagnostic.span.end.offset
    );
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setStatus('Copied');
    } catch {
      setStatus('Copy failed; select the text instead.');
    }
  }

  const diagnostics = checked?.diagnostics ?? [];

  return (
    <div className="modal-backdrop">
      <div
        ref={dialogRef}
        className="history-text-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="history-text-dialog-title"
        aria-describedby="history-text-dialog-summary"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <h2 id="history-text-dialog-title">
          <FileCode2 size={16} aria-hidden="true" />
          History as text
        </h2>
        <p id="history-text-dialog-summary">
          Every parameter and step of {document.name}, in history order.{' '}
          {editable
            ? 'Edit values, names and order here, or edit the model; each follows the other.'
            : 'It follows your edits in the model; read only.'}
        </p>
        {stale && (
          <div className="history-text-stale" role="alert">
            <span>The model changed since you started editing.</span>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setDraft(null);
                setStatus('');
              }}
            >
              Reload text
            </button>
          </div>
        )}
        {printed.error ? (
          <p className="history-text-error" role="alert">
            {printed.error}
          </p>
        ) : (
          <textarea
            ref={textRef}
            className="history-text-body"
            value={text}
            readOnly={!editable || applying}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            wrap="off"
            aria-label={`History text, ${lineCount} lines`}
            aria-invalid={diagnostics.some(
              (diagnostic) => diagnostic.severity === 'error'
            )}
            onChange={(event) => {
              const next = event.target.value;
              setDraft((current) =>
                next === printed.text &&
                (!current || current.baseVersion === document.version)
                  ? null
                  : {
                      text: next,
                      baseVersion: current?.baseVersion ?? document.version
                    }
              );
              setStatus('');
            }}
          />
        )}
        {diagnostics.length > 0 && (
          <ul className="history-text-diagnostics" aria-label="Problems">
            {diagnostics.map((diagnostic, index) => (
              <li key={index} data-severity={diagnostic.severity}>
                <button
                  type="button"
                  onClick={() => focusDiagnostic(diagnostic)}
                >
                  {where(diagnostic)}
                </button>
                <span>
                  {diagnostic.severity === 'warning' ? 'Note: ' : ''}
                  {diagnostic.message}
                </span>
              </li>
            ))}
          </ul>
        )}
        {checked?.proposal && checked.summary.length > 0 && (
          <ul className="history-text-changes" aria-label="Changes">
            {checked.summary.map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ul>
        )}
        <div className="history-text-actions">
          <span className="history-text-status" role="status">
            {status}
          </span>
          {/* One group, so when it and the status do not fit one row the
              status keeps a row of its own above every button. */}
          <div className="history-text-buttons">
            {editable && (
              <>
                <button
                  type="button"
                  className="secondary"
                  disabled={draft === null || applying}
                  onClick={() => {
                    setDraft(null);
                    setStatus('');
                  }}
                >
                  Revert
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={draft === null || applying}
                  onClick={() => check()}
                >
                  Check
                </button>
                <button
                  type="button"
                  className="primary"
                  disabled={
                    draft === null || stale || applying || editBlocked !== null
                  }
                  title={editBlocked ?? undefined}
                  onClick={() => void apply()}
                >
                  Apply
                </button>
              </>
            )}
            <button
              type="button"
              className="secondary"
              disabled={printed.error !== null}
              onClick={() => void copy()}
            >
              Copy
            </button>
            <button type="button" className="secondary" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
