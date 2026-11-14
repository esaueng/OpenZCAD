import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
  type ReactNode
} from 'react';
import { CircleAlert, Trash2 } from 'lucide-react';
import { useModalFocus } from '../lib/useModalFocus';

export interface ConfirmRequest {
  /** The question, e.g. "Delete “Bracket A” forever?". */
  title: string;
  /** What happens and what does not: "This cannot be undone." */
  body?: ReactNode;
  /** The verb on the confirming button, e.g. "Delete forever". */
  confirmLabel: string;
  cancelLabel?: string;
  /**
   * `danger` (the default) paints the confirming button red and shows the
   * bin; `default` is for a confirm that discards nothing for good.
   */
  tone?: 'danger' | 'default';
}

export interface ConfirmDialogProps extends ConfirmRequest {
  onConfirm(): void;
  onCancel(): void;
}

/**
 * The one in-page confirm for a destructive action: library Delete forever
 * and Empty trash, demo Reset, Reset settings, Clear conversation and the
 * like. Built on the DeleteFeatureDialog pattern and shared so every
 * workspace (Build, Assemble, Draw, the cloud dialogs) asks the same way.
 *
 * Never a native `window.confirm()`: embedded and automated browsers answer
 * that with Cancel without ever showing it, so the action did nothing and
 * said nothing. Focus starts on Cancel, so a reflex Enter keeps what was
 * there; Escape cancels too.
 */
export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  cancelLabel = 'Cancel',
  tone = 'danger',
  onConfirm,
  onCancel
}: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const id = useId();
  useModalFocus(dialogRef, { autoFocus: true, initialFocusRef: cancelRef });
  const Icon = tone === 'danger' ? Trash2 : CircleAlert;

  return (
    <div className="modal-backdrop">
      <div
        ref={dialogRef}
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        {...(body ? { 'aria-describedby': `${id}-body` } : {})}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onCancel();
          }
        }}
      >
        <h2 id={`${id}-title`}>
          <Icon size={16} aria-hidden="true" />
          {title}
        </h2>
        {body ? (
          <div id={`${id}-body`} className="confirm-dialog-body">
            {typeof body === 'string' ? <p>{body}</p> : body}
          </div>
        ) : null}
        <div className="confirm-dialog-actions">
          <button
            ref={cancelRef}
            type="button"
            className="secondary"
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={tone === 'danger' ? 'confirm-dialog-danger' : 'primary'}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export interface ConfirmController {
  /**
   * Shows the dialog and settles `true` on the confirming button, `false` on
   * Cancel, Escape, a newer request or the owner unmounting.
   */
  confirm(request: ConfirmRequest): Promise<boolean>;
  /** Render this where the owner renders its other modals. */
  dialog: ReactElement | null;
}

/**
 * A promise-shaped confirm for a call site that used `window.confirm()`:
 * `if (!(await confirm({ … }))) return;`. One request at a time; a second
 * one cancels the first rather than stacking two dialogs.
 */
export function useConfirm(): ConfirmController {
  const [pending, setPending] = useState<{
    request: ConfirmRequest;
    settle(answer: boolean): void;
  } | null>(null);
  const settleRef = useRef<((answer: boolean) => void) | null>(null);

  const confirm = useCallback(
    (request: ConfirmRequest) =>
      new Promise<boolean>((resolve) => {
        settleRef.current?.(false);
        let settled = false;
        const settle = (answer: boolean) => {
          if (settled) return;
          settled = true;
          if (settleRef.current === settle) settleRef.current = null;
          setPending((current) =>
            current?.settle === settle ? null : current
          );
          resolve(answer);
        };
        settleRef.current = settle;
        setPending({ request, settle });
      }),
    []
  );

  useEffect(() => () => settleRef.current?.(false), []);

  const dialog = pending ? (
    <ConfirmDialog
      {...pending.request}
      onConfirm={() => pending.settle(true)}
      onCancel={() => pending.settle(false)}
    />
  ) : null;

  return { confirm, dialog };
}
