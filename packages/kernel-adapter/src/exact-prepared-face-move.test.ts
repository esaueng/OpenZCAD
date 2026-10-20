import { describe, expect, it, vi } from 'vitest';
import type { RemusKernel } from './remus-runtime';
import { journaledMove } from './exact-face-distance';
import {
  preparedFaceMove,
  releasePreparedFaceMove
} from './exact-prepared-face-move';

/** A kernel exposing only what the prepared path and its fallback call. */
function fakeKernel(options: { prepared?: boolean } = {}) {
  let nextHandle = 7;
  const kernel = {
    getSolidFaces: vi.fn(() => Uint32Array.of(1, 2, 3)),
    moveFacesJournaled: vi.fn((): string => {
      throw new Error('journal unavailable');
    }),
    moveFaces: vi.fn(() => 100),
    ...(options.prepared === false
      ? {}
      : {
          prepareMoveFaces: vi.fn(() => nextHandle++),
          moveFacesPreparedJournaled: vi.fn((): string => {
            throw new Error('refused');
          }),
          releasePreparedMove: vi.fn(() => true)
        })
  };
  return { kernel, remus: kernel as unknown as RemusKernel };
}

const faces = Uint32Array.of(2);

describe('preparedFaceMove', () => {
  it('keeps the unprepared move on kernels without prepared moves', () => {
    const { remus } = fakeKernel({ prepared: false });
    expect(preparedFaceMove(remus, 5, faces)).toBeNull();
    expect(preparedFaceMove(remus, 5, faces)).toBeNull();
  });

  it('prepares a target the second time it is moved and reuses it after', () => {
    const { kernel, remus } = fakeKernel();
    expect(preparedFaceMove(remus, 5, faces)).toBeNull();
    expect(kernel.prepareMoveFaces).not.toHaveBeenCalled();

    const prepared = preparedFaceMove(remus, 5, faces);
    expect(kernel.prepareMoveFaces).toHaveBeenCalledExactlyOnceWith(5, faces);
    kernel.moveFacesPreparedJournaled!.mockReturnValueOnce('{}');
    expect(prepared?.moveJournaled(1.5)).toBe('{}');
    expect(kernel.moveFacesPreparedJournaled).toHaveBeenCalledWith(7, 1.5);

    preparedFaceMove(remus, 5, Uint32Array.of(2));
    expect(kernel.prepareMoveFaces).toHaveBeenCalledOnce();
    releasePreparedFaceMove(remus);
  });

  it('releases the preparation when the drag target changes or ends', () => {
    const { kernel, remus } = fakeKernel();
    preparedFaceMove(remus, 5, faces);
    preparedFaceMove(remus, 5, faces);
    // Another face: the old handle goes, the new face waits for a repeat.
    expect(preparedFaceMove(remus, 5, Uint32Array.of(3))).toBeNull();
    expect(kernel.releasePreparedMove).toHaveBeenCalledExactlyOnceWith(7);
    expect(preparedFaceMove(remus, 5, Uint32Array.of(3))).not.toBeNull();
    expect(kernel.prepareMoveFaces).toHaveBeenLastCalledWith(
      5,
      Uint32Array.of(3)
    );

    releasePreparedFaceMove(remus);
    expect(kernel.releasePreparedMove).toHaveBeenLastCalledWith(8);
    // A released target starts over.
    expect(preparedFaceMove(remus, 5, Uint32Array.of(3))).toBeNull();
    // Releasing a target never prepared frees nothing.
    releasePreparedFaceMove(remus);
    expect(kernel.releasePreparedMove).toHaveBeenCalledTimes(2);
  });

  it('falls back to the unprepared move when preparing fails', () => {
    const { kernel, remus } = fakeKernel();
    kernel.prepareMoveFaces!.mockImplementationOnce(() => {
      throw new Error('16 prepared moves are live');
    });
    preparedFaceMove(remus, 5, faces);
    expect(preparedFaceMove(remus, 5, faces)).toBeNull();
    expect(preparedFaceMove(remus, 5, faces)).not.toBeNull();
    releasePreparedFaceMove(remus);
  });
});

describe('journaledMove with a prepared move', () => {
  it('keeps the preparation when the plain move refuses too', () => {
    const { kernel, remus } = fakeKernel();
    kernel.moveFaces.mockImplementation(() => {
      throw new Error('refused');
    });
    preparedFaceMove(remus, 5, faces);
    const prepared = preparedFaceMove(remus, 5, faces);
    expect(() => journaledMove(remus, 5, faces, -2, prepared)).toThrow(
      'refused'
    );
    expect(kernel.moveFacesPreparedJournaled).toHaveBeenCalledWith(7, -2);
    expect(kernel.moveFacesJournaled).not.toHaveBeenCalled();
    expect(kernel.moveFaces).toHaveBeenCalledWith(5, faces, -2);
    expect(kernel.releasePreparedMove).not.toHaveBeenCalled();
    expect(preparedFaceMove(remus, 5, faces)).not.toBeNull();
    releasePreparedFaceMove(remus);
  });

  it('drops a preparation whose plain move succeeds', () => {
    // The prepared move failed where the plain move of the same source
    // succeeds: the source changed since it was prepared.
    const { kernel, remus } = fakeKernel();
    preparedFaceMove(remus, 5, faces);
    const prepared = preparedFaceMove(remus, 5, faces);
    expect(journaledMove(remus, 5, faces, 3, prepared)).toEqual({
      solid: 100,
      relation: null
    });
    expect(kernel.moveFaces).toHaveBeenCalledWith(5, faces, 3);
    expect(kernel.releasePreparedMove).toHaveBeenCalledExactlyOnceWith(7);
    // The next frame sees the target afresh.
    expect(preparedFaceMove(remus, 5, faces)).toBeNull();
  });
});
