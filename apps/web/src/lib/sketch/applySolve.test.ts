import { describe, expect, it } from 'vitest';
import {
  addSketchFeature,
  createProjectDocument,
  findSketch
} from '@openzcad/document-core';
import { toUserId, type EntityId } from '@openzcad/shared';
import type { SketchSolveOutcome } from '@openzcad/kernel-adapter/exact';
import { solveStatusLabel, solvedSketchCommands } from './applySolve';

function fixture() {
  const { document, sketchId } = addSketchFeature(
    createProjectDocument('Solve apply', toUserId('user_sketch')),
    {
      name: 'Profile',
      planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
      objects: [
        { objectKind: 'line', x1: 0, y1: 0, x2: 10, y2: 2 },
        { objectKind: 'circle', radius: 5, centerX: 20, centerY: 0 }
      ]
    }
  );
  const sketch = findSketch(document, sketchId)!;
  const [line, circle] = sketch.objectIds as string[];
  return { document, sketchId, line: line!, circle: circle! };
}

function outcome(
  partial: Partial<SketchSolveOutcome> &
    Pick<SketchSolveOutcome, 'objects'>
): SketchSolveOutcome {
  return {
    classification: 'solved',
    converged: true,
    iterations: 3,
    maxResidual: 1e-12,
    rolledBack: false,
    dof: { dof: 0, rank: 4, numParams: 4, numEquations: 4 },
    constraintResiduals: [],
    ...partial
  };
}

describe('solvedSketchCommands', () => {
  it('writes one update per moved object, spreading existing data', () => {
    const { document, sketchId, line } = fixture();
    const commands = solvedSketchCommands(
      document,
      sketchId,
      outcome({
        objects: [
          {
            objectId: line as EntityId,
            kind: 'line',
            x1: 0,
            y1: 0,
            x2: 10,
            y2: 0
          }
        ]
      })
    );
    expect(commands).toHaveLength(1);
    expect(commands[0]!.payload).toMatchObject({
      sketchId,
      objectId: line,
      data: { objectKind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 }
    });
  });

  it('skips unmoved objects so their stored values survive untouched', () => {
    const { document, sketchId, line, circle } = fixture();
    const commands = solvedSketchCommands(
      document,
      sketchId,
      outcome({
        objects: [
          {
            objectId: line as EntityId,
            kind: 'line',
            x1: 0,
            y1: 0,
            x2: 10,
            y2: 2
          },
          {
            objectId: circle as EntityId,
            kind: 'circle',
            centerX: 20,
            centerY: 0,
            radius: 5
          }
        ]
      })
    );
    expect(commands).toHaveLength(0);
  });

  it('returns nothing for non-converged or rolled-back solves', () => {
    const { document, sketchId, line } = fixture();
    const moved = [
      {
        objectId: line as EntityId,
        kind: 'line' as const,
        x1: 5,
        y1: 5,
        x2: 15,
        y2: 5
      }
    ];
    expect(
      solvedSketchCommands(
        document,
        sketchId,
        outcome({ objects: moved, converged: false })
      )
    ).toHaveLength(0);
    expect(
      solvedSketchCommands(
        document,
        sketchId,
        outcome({ objects: moved, rolledBack: true })
      )
    ).toHaveLength(0);
  });

  it('labels each classification for the status pill', () => {
    expect(solveStatusLabel(outcome({ objects: [] }))).toBe(
      'Fully constrained'
    );
    expect(
      solveStatusLabel(
        outcome({
          objects: [],
          classification: 'underConstrained',
          dof: { dof: 3, rank: 1, numParams: 4, numEquations: 1 }
        })
      )
    ).toBe('3 DOF remaining');
    expect(
      solveStatusLabel(outcome({ objects: [], classification: 'redundant' }))
    ).toBe('Over-constrained');
    expect(
      solveStatusLabel(outcome({ objects: [], classification: 'unsatisfied' }))
    ).toBe('Constraints conflict');
  });
});
