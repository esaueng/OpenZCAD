import { describe, expect, it } from 'vitest';
import type { SketchId } from '@openzcad/shared';
import { sketchEditRaceRefusal, type SketchEditSession } from './editing';

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
