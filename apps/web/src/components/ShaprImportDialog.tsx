import { FileArchive, LoaderCircle, ShieldCheck } from 'lucide-react';
import { useRef } from 'react';

import type { ShaprPairInspection } from '../lib/shaprImportWorkerClient';
import { useModalFocus } from '../lib/useModalFocus';

export type ShaprImportDialogPhase = 'parsing' | 'preview' | 'applying';

export interface ShaprImportDialogProps {
  shaprFileName: string;
  stepFileName: string;
  phase: ShaprImportDialogPhase;
  progress: string;
  error: string | null;
  inspection: ShaprPairInspection | null;
  onCancel(): void;
  onApply(): void;
}

/** Preview-before-apply for a fail-closed paired Shapr3D migration. */
export function ShaprImportDialog({
  shaprFileName,
  stepFileName,
  phase,
  progress,
  error,
  inspection,
  onCancel,
  onApply
}: ShaprImportDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalFocus(dialogRef, { autoFocus: true });
  const ir = inspection?.ir;
  const curveCount =
    ir?.sketches.reduce((count, sketch) => count + sketch.curves.length, 0) ??
    0;
  const constraintCount =
    ir?.sketches.reduce(
      (count, sketch) => count + sketch.constraints.length,
      0
    ) ?? 0;
  const candidateCount =
    ir?.operations.filter((operation) => operation.status === 'candidate')
      .length ?? 0;
  const unsupportedCount =
    ir?.operations.filter(
      (operation) =>
        operation.status === 'unsupported' || operation.status === 'ambiguous'
    ).length ?? 0;
  const busy = phase === 'parsing' || phase === 'applying';

  return (
    <div className="modal-backdrop">
      <div
        ref={dialogRef}
        className="shapr-import-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shapr-import-title"
        onKeyDown={(event) => {
          if (event.key === 'Escape' && phase !== 'applying') {
            event.stopPropagation();
            onCancel();
          }
        }}
      >
        <header>
          <h2 id="shapr-import-title">
            <FileArchive size={16} aria-hidden="true" />
            Preview Shapr3D migration
          </h2>
          <p>
            {shaprFileName} + {stepFileName}
          </p>
        </header>

        {busy ? (
          <p className="shapr-import-progress" role="status">
            <LoaderCircle size={14} className="spin" aria-hidden="true" />
            {progress}
          </p>
        ) : null}

        {error ? (
          <p className="shapr-import-error" role="alert">
            {error}
          </p>
        ) : null}

        {ir ? (
          <>
            <section className="shapr-import-exact">
              <ShieldCheck size={16} aria-hidden="true" />
              <div>
                <strong>Exact geometry is authoritative</strong>
                <p>
                  OpenZCAD will rebuild the sanitized STEP in the exact browser
                  kernel before committing. The recovered history below is
                  evidence only and will not alter geometry.
                </p>
              </div>
            </section>

            <dl className="shapr-import-summary">
              <div>
                <dt>Workspace schema</dt>
                <dd>{ir.schema.workspaceSchemaVersion}</dd>
              </div>
              <div>
                <dt>History nodes</dt>
                <dd>{ir.historyNodeCount}</dd>
              </div>
              <div>
                <dt>Sketches</dt>
                <dd>{ir.sketches.length}</dd>
              </div>
              <div>
                <dt>Curves / constraints</dt>
                <dd>
                  {curveCount} / {constraintCount}
                </dd>
              </div>
              <div>
                <dt>Candidate operations</dt>
                <dd>{candidateCount}</dd>
              </div>
              <div>
                <dt>Unsupported / ambiguous</dt>
                <dd>{unsupportedCount}</dd>
              </div>
            </dl>

            <section className="shapr-import-history">
              <h3>Recognized history</h3>
              <p>
                Numeric values and the metre scale are unverified. After import,
                Auto-parameterize offers only exact planar face distances that
                pass a real changed-value rebuild; source history numbers such
                as 46 mm are not promoted by themselves.
              </p>
              <ol>
                {ir.operations.map((operation) => (
                  <li key={operation.sourceNodeId}>
                    <span>
                      <strong>{operation.name}</strong>
                      <small>{operation.kind}</small>
                    </span>
                    <span className={`shapr-status ${operation.status}`}>
                      {operation.status}
                    </span>
                    {operation.numericCandidates.length > 0 ? (
                      <small title="Unverified source values">
                        values:{' '}
                        {operation.numericCandidates.slice(0, 4).join(', ')}
                        {operation.numericCandidates.length > 4 ? '…' : ''}
                      </small>
                    ) : null}
                  </li>
                ))}
              </ol>
            </section>

            <p className="shapr-import-privacy">
              Private paths, usernames, remote project IDs, thumbnails, UI
              state, and opaque Parasolid data are not added to the document.
            </p>
          </>
        ) : null}

        <div className="shapr-import-actions">
          <button
            type="button"
            className="secondary"
            disabled={phase === 'applying'}
            onClick={onCancel}
          >
            {phase === 'parsing' ? 'Cancel preview' : 'Cancel'}
          </button>
          <button
            type="button"
            className="primary"
            disabled={phase !== 'preview' || !inspection}
            onClick={onApply}
          >
            {phase === 'applying' ? (
              <LoaderCircle size={13} className="spin" aria-hidden="true" />
            ) : null}
            Import exact STEP + evidence
          </button>
        </div>
      </div>
    </div>
  );
}
