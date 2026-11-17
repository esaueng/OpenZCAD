import { describe, expect, it, vi, type Mock } from 'vitest';

import { igesAsStepFile } from './igesImport';
import { runCadFileImport, type StepImportRunDeps } from './stepImportRun';

vi.mock('./igesImport', () => ({ igesAsStepFile: vi.fn() }));

/**
 * I06: Import CAD files reads an IGES B-rep as the STEP the translator
 * restates it to. A file the translator refuses goes to the import card
 * before anything is stored; a cancelled conversion says so instead.
 */
function deps(
  file: File,
  signal?: AbortSignal
): StepImportRunDeps & { refuse: Mock<(message: string) => void> } {
  const untouched = () => {
    throw new Error('nothing may be stored for a refused IGES file');
  };
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
    ...(signal ? { signal } : {}),
    marks: {} as StepImportRunDeps['marks'],
    currentDocument: () => null,
    editDisabledReason: () => null,
    newId: () => 'id',
    refuse: vi.fn<(message: string) => void>()
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

  it('says a cancelled conversion was cancelled, not refused', async () => {
    const abort = new AbortController();
    vi.mocked(igesAsStepFile).mockImplementationOnce(() => {
      abort.abort();
      return Promise.reject(new DOMException('cancelled', 'AbortError'));
    });
    const file = new File(['S      1'], 'part.IGES');
    const run = deps(file, abort.signal);
    await runCadFileImport(run);
    expect(run.refuse).not.toHaveBeenCalled();
    expect(run.status.setStatus).toHaveBeenCalledWith(
      'part.IGES was not imported: you cancelled it.'
    );
  });
});
