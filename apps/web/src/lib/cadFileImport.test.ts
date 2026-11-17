import { describe, expect, it, vi, type Mock } from 'vitest';

import type { ProjectDocument } from '@openzcad/shared';
import { igesAsStepFile } from './igesImport';
import type { ImportProgressSink } from './importProgress';
import { runCadFileImport, type StepImportRunDeps } from './stepImportRun';

vi.mock('./igesImport', () => ({ igesAsStepFile: vi.fn() }));

/**
 * I06: Import CAD files reads an IGES B-rep as the STEP the translator
 * restates it to. A file the translator refuses goes to the import card
 * before anything is stored; a cancelled conversion says so instead; and an
 * import started in one project never lands in another.
 */
function deps(
  file: File,
  signal?: AbortSignal
): StepImportRunDeps & {
  refuse: Mock<(message: string) => void>;
  progress: ImportProgressSink;
  openProject: { id: string };
} {
  const untouched = () => {
    throw new Error('nothing may be stored for this IGES file');
  };
  const openProject = { id: 'project_a' };
  return {
    file,
    contentType: 'model/iges',
    store: {
      ensureLocalProjectStorage: vi.fn(untouched)
    } as unknown as StepImportRunDeps['store'],
    archive: vi.fn(untouched),
    validatedFeature: {
      reserve: vi.fn(untouched),
      run: vi.fn(untouched)
    },
    status: { setStatus: vi.fn(), setFeatureFormError: vi.fn() },
    progress: { start: vi.fn(), update: vi.fn(), finish: vi.fn() },
    ...(signal ? { signal } : {}),
    marks: {} as StepImportRunDeps['marks'],
    currentDocument: () =>
      ({ projectId: openProject.id }) as unknown as ProjectDocument,
    editDisabledReason: () => null,
    newId: () => 'id',
    refuse: vi.fn<(message: string) => void>(),
    openProject
  };
}

describe('runCadFileImport (I06)', () => {
  it('refuses an IGES file the translator cannot restate, storing nothing', async () => {
    vi.mocked(igesAsStepFile).mockRejectedValueOnce(
      new Error('IGES surface model: 12 trimmed surfaces and no 186 solid.')
    );
    const file = new File(['S      1'], 'plate.igs');
    const run = deps(file);
    await runCadFileImport(run);
    expect(run.refuse).toHaveBeenCalledWith(
      'IGES surface model: 12 trimmed surfaces and no 186 solid.'
    );
    expect(run.store!.ensureLocalProjectStorage).not.toHaveBeenCalled();
    expect(run.status.setStatus).not.toHaveBeenCalled();
  });

  it('shows the conversion on a card whose Cancel stops it', async () => {
    const abort = new AbortController();
    vi.mocked(igesAsStepFile).mockImplementationOnce(() => {
      abort.abort();
      return Promise.reject(new DOMException('cancelled', 'AbortError'));
    });
    const file = new File(['S      1'], 'part.IGES');
    const run = deps(file, abort.signal);
    await runCadFileImport(run);
    expect(run.progress.start).toHaveBeenCalledWith({
      fileName: 'part.IGES',
      phases: ['preparing']
    });
    expect(run.refuse).not.toHaveBeenCalled();
    expect(run.status.setStatus).toHaveBeenCalledWith(
      'part.IGES was not imported: you cancelled it.'
    );
    expect(run.progress.finish).toHaveBeenCalledWith(
      expect.objectContaining({ tone: 'cancelled' })
    );
  });

  it('never lands in a project the user switched to during conversion', async () => {
    const file = new File(['S      1'], 'cavity.igs');
    const run = deps(file);
    vi.mocked(igesAsStepFile).mockImplementationOnce(() => {
      run.openProject.id = 'project_b';
      return Promise.resolve(new File(['ISO-10303-21;'], 'cavity.igs'));
    });
    await runCadFileImport(run);
    expect(run.status.setStatus).toHaveBeenCalledWith(
      'cavity.igs was not imported: the project changed before it could land.'
    );
    expect(run.store!.ensureLocalProjectStorage).not.toHaveBeenCalled();
    expect(run.validatedFeature.reserve).not.toHaveBeenCalled();
    expect(run.progress.finish).toHaveBeenCalledWith(
      expect.objectContaining({ tone: 'error' })
    );
  });
});
