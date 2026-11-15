/**
 * File → Insert project…, from the picked backup to the committed bodies.
 * Loaded on that gesture only. The other project is rebuilt and written as
 * one STEP in a disposable worker (`projectInsertWorkerClient`), then
 * imported as any STEP is (`runStepImport`) under the layout
 * `projectInsert` gives it: one body per source body, named, coloured and
 * filed in a folder named after the project, in one undoable step.
 */
import type { UserId } from '@openzcad/shared';

import { exportFileStem } from './model';
import { describeProjectImportFailure } from './plainFailure';
import { projectInsertLayout, projectInsertLeftOut } from './projectInsert';
import {
  insertEncryptionRefusal,
  type ProjectInsertDestination
} from './projectInsertEncryption';
import { prepareProjectInsertInWorker } from './projectInsertWorkerClient';
import type { ImportProgressSink } from './importProgress';
import { runStepImport, type StepImportRunDeps } from './stepImportRun';
import { countLabel } from './toasts';

export interface ProjectInsertRunDeps {
  file: File;
  ownerUserId: UserId;
  signal: AbortSignal;
  progress: ImportProgressSink;
  setStatus(message: string, options?: { detail?: string }): void;
  /** False once the project that was open when the file was picked is not. */
  stillCurrent(): boolean;
  /**
   * The open project the bodies go into, read once the other project is
   * prepared: its encryption decides whether the insert may go ahead
   * (`projectInsertEncryption.ts`). Null when none is open.
   */
  destination(): ProjectInsertDestination | null;
  /** Told when the insert fails for any reason but a cancel. */
  onFailure?(): void;
  /** The STEP import's own collaborators, as Import CAD files passes them. */
  stepImport: Pick<
    StepImportRunDeps,
    | 'archive'
    | 'validatedFeature'
    | 'status'
    | 'marks'
    | 'currentDocument'
    | 'editDisabledReason'
    | 'newId'
    | 'store'
    | 'inspectSolids'
  >;
}

export async function runProjectInsert(
  deps: ProjectInsertRunDeps
): Promise<void> {
  const { file, signal, setStatus } = deps;
  // The card starts here, before the STEP import's own run; a run that
  // declines early (busy, storage blocked, too large) never finishes it.
  let finished = false;
  const progress: ImportProgressSink = {
    ...deps.progress,
    finish: (outcome) => {
      finished = true;
      deps.progress.finish(outcome);
    }
  };
  progress.start({ fileName: file.name, phases: ['reading', 'building'] });
  try {
    const prepared = await prepareProjectInsertInWorker(
      file,
      deps.ownerUserId,
      signal
    );
    if (!deps.stillCurrent()) {
      const message = 'The project changed while the other one was read.';
      progress.finish({ tone: 'warning', message });
      setStatus(message);
      return;
    }
    // Settled before the STEP import stores, archives or commits anything:
    // the source's id is gone from the prepared content, so the send gate
    // sees only this project's id from here on.
    const destination = deps.destination();
    const refusal = destination
      ? insertEncryptionRefusal(prepared.sourceProjectId, destination)
      : 'No project is open.';
    if (refusal) {
      progress.finish({ tone: 'error', message: 'nothing was added' });
      setStatus(`${prepared.projectName} was not inserted. ${refusal}`);
      return;
    }
    let dropped: string[] = [];
    await runStepImport({
      ...deps.stepImport,
      stillCurrent: deps.stillCurrent,
      file: new File(
        [prepared.stepText],
        `${exportFileStem(prepared.projectName)}.step`,
        { type: 'model/step' }
      ),
      contentType: 'model/step',
      signal,
      progress,
      layout: (input) => {
        const layout = projectInsertLayout(prepared, input);
        dropped = layout.dropped;
        return layout;
      },
      validatingMessage: `Checking ${prepared.projectName} against exact geometry…`,
      successMessage: ({ bodies, archived }) =>
        `Inserted ${countLabel(bodies, 'body', 'bodies')} from ${prepared.projectName}` +
        (archived ? '.' : ' (source saved on this device only).') +
        projectInsertLeftOut(prepared, dropped)
    });
    // Its reason is already in the status line.
    if (!finished) {
      progress.finish({ tone: 'warning', message: 'nothing was added' });
    }
  } catch (error) {
    if (signal.aborted) {
      progress.finish({ tone: 'cancelled', message: 'nothing was added' });
      setStatus(`${file.name} was not inserted: you cancelled it.`);
      return;
    }
    deps.onFailure?.();
    const plain = await describeProjectImportFailure(error, file);
    progress.finish({ tone: 'error', message: plain.message });
    setStatus(
      `Project insert failed. ${plain.message}`,
      plain.detail ? { detail: plain.detail } : {}
    );
  }
}
