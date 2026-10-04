import { describe, expect, it } from 'vitest';
import type { SketchId } from '@openzcad/shared';
import { sketchEditRaceRefusal, type SketchEditSession } from './editing';
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
