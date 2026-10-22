import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  addSketchFeature,
  addSketchReferenceDimension,
  createProjectDocument,
  findSketch,
  resolvedSketchDocument
} from '@openzcad/document-core';
import { computeSketchProfileAnalysis } from '@openzcad/geometry';
import { toUserId, type SketchObjectData } from '@openzcad/shared';
import { SketchEntityEditor } from './SketchEntityEditor';
import { SketchReferenceDimensions } from './SketchReferenceDimensions';
import {
  buildConstraint,
  measureDrivingDimension
} from '../lib/sketch/constraints';
import { sketchDimensionAnnotations } from '../lib/sketch/dimensionAnnotations';
import { resolveOffsetSource } from '../lib/sketch/offset';
import { resolveSketchCorner } from '../lib/sketch/edits';
import {
  planSketchConstructionToggle,
  planSketchMirror
} from '../lib/sketch/modify';
import { countClosedProfileSketches } from '../lib/sketch/profileAvailability';
import { collectSketchSnapTargets } from '../lib/sketch/session';

const rectangle = (width: number): SketchObjectData[] => [
  { objectKind: 'line', x1: 0, y1: 0, x2: width, y2: 0 },
  { objectKind: 'line', x1: width, y1: 0, x2: width, y2: 6 },
  { objectKind: 'line', x1: width, y1: 6, x2: 0, y2: 6 },
  { objectKind: 'line', x1: 0, y1: 6, x2: 0, y2: 0 }
];

function fixture() {
  const objects = rectangle(20);
  objects[0] = { objectKind: 'line', x1: 0, y1: 0, x2: '20', y2: 0 };
  const added = addSketchFeature(
    createProjectDocument('Solved editor view', toUserId('user_solved_view')),
    { name: 'Outline', plane: 'XY', objects }
  );
  const sketch = findSketch(added.document, added.sketchId)!;
  const lineId = sketch.objectIds[0]!;
  const { document } = addSketchReferenceDimension(added.document, {
    sketchId: sketch.sketchId,
    data: {
      dimensionKind: 'distance',
      a: { objectId: lineId, point: 'start' },
      b: { objectId: lineId, point: 'end' }
    }
  });
  document.derived.sketchGeometry = {
    projectId: document.projectId,
    documentVersion: document.version,
    objects: Object.fromEntries(
      sketch.objectIds.map((id, i) => [id, rectangle(32)[i]!])
    )
  };
  const view = resolvedSketchDocument(document);
  const entries = sketch.objectIds.flatMap((id) => {
    const node = view.nodes[id];
    return node?.kind === 'sketch-object'
      ? [{ id, label: 'Outline', data: node.data }]
      : [];
  });
  return {
    document,
    sketch: findSketch(document, sketch.sketchId)!,
    lineId,
    entries
  };
}

describe('solved sketch geometry readers', () => {
  it('uses one solved outline for snaps, profile picks and saved reference dimensions', () => {
    const f = fixture();
    const before = structuredClone(f.document);
    const resolve = Number;
    expect(collectSketchSnapTargets(f.entries, resolve)).toContainEqual(
      expect.objectContaining({ x: 32, y: 0, kind: 'endpoint' })
    );
    expect(
      computeSketchProfileAnalysis(f.entries, resolve).profiles[0]
    ).toMatchObject({
      area: 192,
      boundingBox: { max: { x: 32, y: 6 } }
    });
    expect(countClosedProfileSketches(f.document, {})).toBe(1);
    expect(
      sketchDimensionAnnotations(
        f.entries,
        [],
        resolve,
        'mm',
        undefined,
        f.sketch.referenceDimensions
      )[0]
    ).toMatchObject({ label: '(32 mm)' });
    render(
      <SketchReferenceDimensions
        sketch={f.sketch}
        objects={f.entries}
        units="mm"
        resolve={Number}
        disabled={false}
        onCommand={vi.fn()}
      />
    );
    expect(
      within(screen.getByRole('listitem')).getByText('32 mm · Reference')
    ).toBeTruthy();
    expect(f.document).toEqual(before);
  });

  it('plans a new dimension, lock and offset from solved coordinates on a canonical command base', () => {
    const f = fixture();
    const before = structuredClone(f.document);
    const start = {
      kind: 'point' as const,
      objectId: f.lineId,
      point: 'start' as const
    };
    const end = {
      kind: 'point' as const,
      objectId: f.lineId,
      point: 'end' as const
    };
    expect(
      measureDrivingDimension(
        f.document,
        f.sketch,
        'distance',
        [start, end],
        Number
      )
    ).toEqual({ value: 32 });
    expect(
      buildConstraint(f.document, f.sketch, 'lock', [end], undefined, Number)
    ).toMatchObject({ data: { constraintKind: 'lock', x: 32, y: 0 } });
    expect(
      resolveOffsetSource(f.document, f.sketch, f.lineId, false, Number)
    ).toMatchObject({
      source: { kind: 'chain', members: [{ data: { x2: 32 } }] }
    });
    expect(
      resolveSketchCorner(
        f.document,
        f.sketch,
        f.lineId,
        f.sketch.objectIds[1]!,
        Number
      )
    ).toMatchObject({
      corner: {
        corner: { x: 32, y: 0 },
        farA: { x: 0, y: 0 },
        farB: { x: 32, y: 6 }
      }
    });
    const mirror = planSketchMirror(
      f.document,
      f.sketch,
      f.sketch.sketchId,
      f.lineId,
      f.sketch.objectIds[3]!,
      Number
    );
    if (mirror.status !== 'commands') throw new Error(mirror.reason);
    expect(
      mirror.commands.find((command) => command.kind === 'sketch.object.add')
        ?.payload
    ).toMatchObject({ objects: [{ x2: -32 }] });
    const toggle = planSketchConstructionToggle(
      f.document,
      f.sketch,
      f.sketch.sketchId,
      f.lineId
    );
    if (toggle.status !== 'commands') throw new Error(toggle.reason);
    expect(toggle.commands[0]?.payload).toMatchObject({
      data: { x2: '20', construction: true }
    });
    expect(f.document).toEqual(before);
    expect(f.document.nodes[f.lineId]).toMatchObject({ data: { x2: '20' } });
  });

  it('shows solved entity values and preserves untouched authored expressions on Apply', async () => {
    const f = fixture();
    const authored = f.document.nodes[f.lineId];
    if (authored?.kind !== 'sketch-object')
      throw new Error('Expected authored line.');
    const onApply = vi.fn();
    render(
      <SketchEntityEditor
        data={f.entries[0]!.data}
        authoredData={authored.data}
        scope={{}}
        onApply={onApply}
        onDelete={vi.fn()}
        onClose={vi.fn()}
      />
    );
    expect(screen.getByLabelText('End X')).toHaveValue('32');
    const user = userEvent.setup();
    await user.clear(screen.getByLabelText('Start Y'));
    await user.type(screen.getByLabelText('Start Y'), '1');
    await user.click(screen.getByRole('button', { name: /apply/i }));
    expect(onApply).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ x2: '20', y1: 1 })
    );
    expect(authored.data).toMatchObject({ x2: '20', y1: 0 });
  });

  it('keeps profile availability on the current solved geometry', () => {
    const f = fixture();
    const finalId = f.sketch.objectIds[3]!;
    f.document.derived.sketchGeometry = {
      ...f.document.derived.sketchGeometry!,
      objects: {
        ...f.document.derived.sketchGeometry!.objects,
        [finalId]: { objectKind: 'line', x1: 100, y1: 100, x2: 100, y2: 101 }
      }
    };
    expect(countClosedProfileSketches(f.document, {})).toBe(0);
    f.document.version += 1;
    expect(countClosedProfileSketches(f.document, {})).toBe(1);
  });

  it('keeps relation release and editing controls disabled while current geometry is unavailable', async () => {
    const f = fixture();
    const onDelete = vi.fn();
    const onEdit = vi.fn();
    render(
      <SketchEntityEditor
        data={f.entries[0]!.data}
        scope={{}}
        disabled
        onApply={vi.fn()}
        onDelete={vi.fn()}
        onClose={vi.fn()}
        constraints={[
          {
            constraintId: 'constraint_width',
            kind: 'distance',
            label: 'Width',
            editable: true
          }
        ]}
        onDeleteConstraint={onDelete}
        onEditConstraint={onEdit}
      />
    );
    const user = userEvent.setup();
    const release = screen.getByRole('button', {
      name: 'Delete constraint: Width'
    });
    const edit = screen.getByRole('button', { name: 'Edit constraint: Width' });
    expect(release).toBeDisabled();
    expect(edit).toBeDisabled();
    await user.click(release);
    await user.click(edit);
    expect(onDelete).not.toHaveBeenCalled();
    expect(onEdit).not.toHaveBeenCalled();
  });
});
