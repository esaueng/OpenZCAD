import { useMemo, useRef, useState } from 'react';
import { FileCode2 } from 'lucide-react';
import { printHistory } from '@openzcad/scripting';
import type { ProjectDocument } from '@openzcad/shared';
import { useModalFocus } from '../lib/useModalFocus';

export interface HistoryTextDialogProps {
  document: ProjectDocument;
  onClose(): void;
}

/**
 * L15: the model's feature history as text. A projection of the open
 * document, printed again whenever the document changes, so an edit made in
 * the app shows here at once. Loaded on demand with the scripting package,
 * outside the entry bundle.
 */
export default function HistoryTextDialog({
  document,
  onClose
}: HistoryTextDialogProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const textRef = useRef<HTMLPreElement | null>(null);
  const [copied, setCopied] = useState<'copied' | 'failed' | null>(null);
  useModalFocus(dialogRef, { autoFocus: true, initialFocusRef: textRef });

  const printed = useMemo(() => {
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
  }, [document]);
  const lineCount = useMemo(
    () => printed.text.split('\n').length - 1,
    [printed.text]
  );

  async function copy() {
    try {
      await navigator.clipboard.writeText(printed.text);
      setCopied('copied');
    } catch {
      setCopied('failed');
    }
  }

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
          Every parameter and step of {document.name}, in history order. It
          follows your edits in the model; read only.
        </p>
        {printed.error ? (
          <p className="history-text-error" role="alert">
            {printed.error}
          </p>
        ) : (
          <pre
            ref={textRef}
            className="history-text-body"
            tabIndex={0}
            aria-label={`History text, ${lineCount} lines`}
          >
            {printed.text}
          </pre>
        )}
        <div className="history-text-actions">
          <span className="history-text-status" role="status">
            {copied === 'copied'
              ? 'Copied'
              : copied === 'failed'
                ? 'Copy failed; select the text instead.'
                : ''}
          </span>
          <button
            type="button"
            className="secondary"
            disabled={printed.error !== null}
            onClick={() => void copy()}
          >
            Copy
          </button>
          <button type="button" className="primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
