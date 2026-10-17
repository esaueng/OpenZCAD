import { describe, expect, it, vi } from 'vitest';
import { commandFactories } from '@openzcad/command-system';
import {
  addSketchFeature,
  addSketchObjects,
  createProjectDocument,
  extrudeSketch,
  findSketch
} from '@openzcad/document-core';
import {
  toUserId,
  type ProjectDocument,
  type SketchId
} from '@openzcad/shared';
import { FeatureBuildError } from '../featureValidation';
import {
  checkSketchEdit,
  sketchEditRaceRefusal,
  type SketchEditSession
} from './editing';
import { sketchEntityEditTarget } from './editTarget';

const SKETCH_ID = 'sketch_race' as SketchId;

function session(
  sketchId: string | null = SKETCH_ID,
  selectedObjectId: string | null = null
): SketchEditSession {
  return {
    mode: 'sketch' as const,
    session: { sketchId, selectedObjectId }
  };
}

describe('sketchEditRaceRefusal', () => {
  it('allows a commit when nothing moved', () => {
    const base = { projectId: 'proj_1', version: 3 };
    expect(
      sketchEditRaceRefusal(base, SKETCH_ID, { ...base }, session())
    ).toBeNull();
  });

  it('refuses with a user-facing message when the document moved mid-validate', () => {
    const base = { projectId: 'proj_1', version: 3 };
    const moved = { projectId: 'proj_1', version: 4 };
    const refusal = sketchEditRaceRefusal(base, SKETCH_ID, moved, session());
    expect(refusal).toMatch(/no change was saved/i);
  });

  it('refuses when the project, mode, sketch, or selection changed', () => {
    const base = { projectId: 'proj_1', version: 3 };
    const live = { ...base };
    const message = /no change was saved/i;
    expect(
      sketchEditRaceRefusal(
        base,
        SKETCH_ID,
        { projectId: 'proj_2', version: 3 },
        session()
      )
    ).toMatch(message);
    expect(sketchEditRaceRefusal(base, SKETCH_ID, null, session())).toMatch(
      message
    );
    expect(
      sketchEditRaceRefusal(base, SKETCH_ID, live, {
        mode: 'idle',
        session: { sketchId: SKETCH_ID, selectedObjectId: null }
      })
    ).toMatch(message);
    expect(
      sketchEditRaceRefusal(base, SKETCH_ID, live, session('sketch_other'))
    ).toMatch(message);
    // A selection move only matters for object-targeted commits.
    expect(
      sketchEditRaceRefusal(
        base,
        SKETCH_ID,
        live,
        session(SKETCH_ID, 'entity_moved'),
        'entity_pinned'
      )
    ).toMatch(message);
    expect(
      sketchEditRaceRefusal(
        base,
        SKETCH_ID,
        live,
        session(SKETCH_ID, 'entity_moved')
      )
    ).toBeNull();
  });
});

describe('sketchEntityEditTarget', () => {
  const base = { projectId: 'proj_1', version: 3 };

  it('a released drag commits its object after the selection moves on', () => {
    // Release a drag of entity_dragged: the commit captures it...
    const target = sketchEntityEditTarget(
      session(SKETCH_ID, 'entity_dragged'),
      'entity_dragged'
    );
    expect(target).toEqual({
      sketchId: SKETCH_ID,
      objectId: 'entity_dragged'
    });
    // ...and the user selects another object before the edit answers. The
    // move is still written to the dragged object, and the new selection is
    // left alone.
    const live = session(SKETCH_ID, 'entity_other');
    expect(
      sketchEditRaceRefusal(
        base,
        SKETCH_ID,
        { ...base },
        live,
        target!.raceObjectId
      )
    ).toBeNull();
    expect(live.session?.selectedObjectId).toBe('entity_other');
    // A document change in the meantime still refuses it.
    expect(
      sketchEditRaceRefusal(
        base,
        SKETCH_ID,
        { ...base, version: 4 },
        live,
        target!.raceObjectId
      )
    ).toMatch(/no change was saved/i);
  });

  it('an editor edit stays bound to the selection', () => {
    const target = sketchEntityEditTarget(session(SKETCH_ID, 'entity_a'));
    expect(target).toEqual({
      sketchId: SKETCH_ID,
      objectId: 'entity_a',
      raceObjectId: 'entity_a'
    });
    expect(
      sketchEditRaceRefusal(
        base,
        SKETCH_ID,
        { ...base },
        session(SKETCH_ID, 'entity_b'),
        target!.raceObjectId
      )
    ).toMatch(/no change was saved/i);
  });

  it('names nothing outside a sketch or without a selection', () => {
    expect(sketchEntityEditTarget(session(SKETCH_ID, null))).toBeNull();
    expect(sketchEntityEditTarget(session(null, 'entity_a'))).toBeNull();
    expect(
      sketchEntityEditTarget(
        {
          mode: 'idle',
          session: { sketchId: SKETCH_ID, selectedObjectId: null }
        },
        'entity_a'
      )
    ).toBeNull();
  });
});

describe('checkSketchEdit for a delete', () => {
  function sketchWithLine(extrude: boolean) {
    const start = createProjectDocument('Delete', toUserId('user_delete'));
    const sketched = addSketchFeature(start, {
      name: 'Profile',
      plane: 'XY',
      offset: 0,
      object: {
        objectKind: 'rectangle',
        width: 20,
        height: 12,
        centerX: 0,
        centerY: 0
      }
    });
    const lined = addSketchObjects(sketched.document, {
      sketchId: sketched.sketchId,
      objects: [{ objectKind: 'line', x1: 30, y1: 0, x2: 40, y2: 0 }]
    });
    const document = extrude
      ? extrudeSketch(lined.document, {
          name: 'Block',
          sketchId: sketched.sketchId,
          distance: 5
        }).document
      : lined.document;
    return {
      document,
      sketchId: sketched.sketchId,
      lineId: lined.objectNodeIds[0]!
    };
  }

  function deleteCommand(sketchId: SketchId, objectId: string) {
    return commandFactories.deleteSketchObject({
      sketchId,
      objectId: objectId as never
    });
  }

  it('refuses a delete that leaves a dependent feature without its body', async () => {
    const { document, sketchId, lineId } = sketchWithLine(true);
    const derive = vi.fn(
      async (next: ProjectDocument) =>
        ({ ...next.derived, warnings: [], bodyRepresentations: {} }) as never
    );
    const check = checkSketchEdit(
      document,
      sketchId,
      [deleteCommand(sketchId, lineId)],
      derive
    );
    await expect(check).rejects.toBeInstanceOf(FeatureBuildError);
    await expect(check).rejects.toThrow(
      /^Block: .*The sketch edit was not saved\.$/
    );
    // The candidate it rebuilt is the document without the line.
    const candidate = derive.mock.calls[0]![0];
    expect(
      findSketch(candidate, sketchId)!.objectIds.includes(lineId as never)
    ).toBe(false);
    // The base document is untouched.
    expect(
      findSketch(document, sketchId)!.objectIds.includes(lineId as never)
    ).toBe(true);
  });

  it('commits a delete the dependents survive, and skips the rebuild when nothing depends on the sketch', async () => {
    const dependent = sketchWithLine(true);
    const derive = vi.fn(async (next: ProjectDocument) => {
      const block = Object.keys(next.nodes).find(
        (id) =>
          next.nodes[id]?.kind === 'feature' &&
          (next.nodes[id] as { name: string }).name === 'Block'
      )!;
      const bodyId = (next.nodes[block] as { bodyId: string }).bodyId;
      return {
        ...next.derived,
        warnings: [],
        bodyRepresentations: { [bodyId]: {} }
      } as never;
    });
    await expect(
      checkSketchEdit(
        dependent.document,
        dependent.sketchId,
        [deleteCommand(dependent.sketchId, dependent.lineId)],
        derive
      )
    ).resolves.toBeDefined();
    expect(derive).toHaveBeenCalledTimes(1);

    const alone = sketchWithLine(false);
    const unused = vi.fn();
    await expect(
      checkSketchEdit(
        alone.document,
        alone.sketchId,
        [deleteCommand(alone.sketchId, alone.lineId)],
        unused
      )
    ).resolves.toBeUndefined();
    expect(unused).not.toHaveBeenCalled();
  });
});
