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

describe('explicit sampled cap reconstruction', () => {
  function qualityKernel() {
    const fake = fakeKernel();
    const payload = {
      solid: 100,
      op: 9,
      quality: 'approximate',
      construction: 'sampledCapJoin',
      cornerStations: 256,
      faceEvolution: {
        origin: 'construction',
        modified: { 1: [10], 2: [20] },
        deleted: [3],
        generated: { 2: [30, 40], 3: [30, 40] },
        unresolved: {}
      }
    };
    const kernel = Object.assign(fake.kernel, {
      moveFacesJournaledWithQuality: vi.fn(() => JSON.stringify(payload)),
      moveFacesPreparedJournaledWithQuality: vi.fn(() =>
        JSON.stringify(payload)
      )
    });
    kernel.getSolidFaces.mockImplementation((solid?: number) =>
      Uint32Array.from(solid === 100 ? [10, 20, 30, 40] : [1, 2, 3])
    );
    return { ...fake, kernel, payload };
  }

  it('requires opt-in and preserves surviving picks through changed face counts', () => {
    const { remus, kernel } = qualityKernel();
    journaledMove(remus, 5, faces, 5);
    expect(kernel.moveFacesJournaledWithQuality).not.toHaveBeenCalled();
    const moved = journaledMove(remus, 5, faces, 5, null, true);
    expect(moved.approximateCapJoin).toBe(true);
    expect(moved.relation?.faceMap).toEqual(
      new Map([
        [1, 10],
        [2, 20]
      ])
    );
    expect(moved.relation?.conflictedSources).toEqual(new Set([3]));
    expect(kernel.moveFacesJournaledWithQuality).toHaveBeenCalledWith(
      5,
      faces,
      5,
      256
    );
  });

  it('carries the same quality and construction map through a prepared drag', () => {
    const { remus, kernel } = qualityKernel();
    preparedFaceMove(remus, 5, faces);
    const prepared = preparedFaceMove(remus, 5, faces);
    const moved = journaledMove(remus, 5, faces, 5, prepared, true);
    expect(moved.approximateCapJoin).toBe(true);
    expect(moved.relation?.faceMap.get(2)).toBe(20);
    expect(kernel.moveFacesPreparedJournaledWithQuality).toHaveBeenCalledWith(
      7,
      5,
      256
    );
    expect(kernel.moveFacesJournaledWithQuality).not.toHaveBeenCalled();
    releasePreparedFaceMove(remus);
  });

  it('refuses unknown quality or incomplete history without dropping to the plain move', () => {
    const { remus, kernel, payload } = qualityKernel();
    kernel.moveFacesJournaledWithQuality.mockReturnValueOnce(
      JSON.stringify({ ...payload, quality: 'unknown' })
    );
    expect(() => journaledMove(remus, 5, faces, 5, null, true)).toThrow(
      'unrecognized construction quality'
    );
    delete (payload.faceEvolution.modified as Record<string, number[]>)[1];
    expect(() => journaledMove(remus, 5, faces, 5, null, true)).toThrow(
      'incomplete construction history'
    );
    expect(kernel.moveFaces).not.toHaveBeenCalled();
  });

  it('retries a refused prepared call once with the same approximation permission', () => {
    const { remus, kernel } = qualityKernel();
    preparedFaceMove(remus, 5, faces);
    const prepared = preparedFaceMove(remus, 5, faces);
    kernel.moveFacesPreparedJournaledWithQuality.mockImplementationOnce(() => {
      throw new Error('prepared source changed');
    });
    expect(
      journaledMove(remus, 5, faces, 5, prepared, true).approximateCapJoin
    ).toBe(true);
    expect(kernel.releasePreparedMove).toHaveBeenCalledExactlyOnceWith(7);
    expect(
      kernel.moveFacesJournaledWithQuality
    ).toHaveBeenCalledExactlyOnceWith(5, faces, 5, 256);
    expect(kernel.moveFaces).not.toHaveBeenCalled();
  });

  it('does not repeat a completed prepared edit whose quality cannot be verified', () => {
    const { remus, kernel, payload } = qualityKernel();
    preparedFaceMove(remus, 5, faces);
    const prepared = preparedFaceMove(remus, 5, faces);
    kernel.moveFacesPreparedJournaledWithQuality.mockReturnValueOnce(
      JSON.stringify({ ...payload, quality: 'unknown' })
    );
    expect(() => journaledMove(remus, 5, faces, 5, prepared, true)).toThrow(
      'unrecognized construction quality'
    );
    expect(kernel.moveFacesJournaledWithQuality).not.toHaveBeenCalled();
    expect(kernel.moveFaces).not.toHaveBeenCalled();
    releasePreparedFaceMove(remus);
  });
});
