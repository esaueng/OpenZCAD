import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  CommandManager,
  composeCommands,
  type AnyCommand
} from '@openzcad/command-system';
import {
  addSketchFeature,
  addSketchReferenceDimension,
  createProjectDocument,
  findSketch
} from '@openzcad/document-core';
import {
  createSketchCompositeCornerTarget,
  createSketchCompositeSideTarget,
  toUserId,
  toSketchCompositeId,
  type SketchComposite
} from '@openzcad/shared';
import { SketchReferenceDimensions } from './SketchReferenceDimensions';
import {
  compositeCommands,
  cornerRectangleShape,
  inscribedPolygonShape
} from '../lib/sketch/composites';
import { SKETCH_SNAP_LIMITS } from '../lib/sketch/session';

function fixture() {
  const added = addSketchFeature(
    createProjectDocument('References', toUserId('user_test')),
    {
      name: 'Sketch',
      plane: 'XY',
      objects: [
        { objectKind: 'line', x1: 0, y1: 0, x2: 3, y2: 4 },
        { objectKind: 'line', x1: 0, y1: 0, x2: 0, y2: 5 },
        { objectKind: 'circle', centerX: 10, centerY: 10, radius: 2 }
      ]
    }
  );
  const sketch = findSketch(added.document, added.sketchId)!;
  const objects = sketch.objectIds.map((id, i) => ({
    id,
    label: ['Diagonal', 'Upright', 'Circle'][i]!,
    data:
      added.document.nodes[id]!.kind === 'sketch-object'
        ? added.document.nodes[id]!.data
        : { objectKind: 'line' as const, x1: 0, y1: 0, x2: 1, y2: 0 }
  }));
  return { ...added, sketch, objects };
}

describe('reference dimension palette', () => {
  it.each([
    ['horizontal', 3],
    ['vertical', 4]
  ] as const)(
    'authors a read-only %s distance with its mode and measured value',
    (distanceMode, value) => {
      const { sketch, objects } = fixture();
      const onAdd = vi.fn<(command: AnyCommand) => void>();
      render(
        <SketchReferenceDimensions
          sketch={sketch}
          objects={objects}
          units="mm"
          resolve={(v) => (typeof v === 'number' ? v : undefined)}
          disabled={false}
          onCommand={onAdd}
        />
      );
      fireEvent.change(screen.getByLabelText('Distance type'), {
        target: { value: distanceMode }
      });
      for (const [name, point] of [
        ['Reference from', 'start'],
        ['Reference to', 'end']
      ])
        fireEvent.change(screen.getByLabelText(name!), {
          target: { value: JSON.stringify({ objectId: objects[0]!.id, point }) }
        });
      expect(screen.getByRole('status').textContent).toBe(
        `Measured: ${value} mm`
      );
      expect(screen.queryByRole('textbox')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Add reference' }));
      expect(onAdd.mock.calls[0]![0].payload).toMatchObject({
        data: { dimensionKind: 'distance', distanceMode }
      });
    }
  );
  it('creates an absolute point distance from current measured targets, without a value field', () => {
    const { sketch, objects } = fixture();
    const onAdd = vi.fn<(command: AnyCommand) => void>();
    render(
      <SketchReferenceDimensions
        sketch={sketch}
        objects={objects}
        units="mm"
        resolve={(v) => (typeof v === 'number' ? v : undefined)}
        disabled={false}
        onCommand={onAdd}
      />
    );
    const from = screen.getByLabelText('Reference from');
    const to = screen.getByLabelText('Reference to');
    fireEvent.change(from, {
      target: {
        value: JSON.stringify({ objectId: objects[0]!.id, point: 'start' })
      }
    });
    fireEvent.change(to, {
      target: {
        value: JSON.stringify({ objectId: objects[0]!.id, point: 'end' })
      }
    });
    expect(screen.getByRole('status').textContent).toBe('Measured: 5 mm');
    expect(screen.queryByRole('textbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add reference' }));
    expect(onAdd.mock.calls[0]![0].payload).toMatchObject({
      data: {
        dimensionKind: 'distance',
        a: { objectId: objects[0]!.id, point: 'start' },
        b: { objectId: objects[0]!.id, point: 'end' }
      }
    });
    fireEvent.change(to, {
      target: {
        value: JSON.stringify({ objectId: objects[0]!.id, point: 'start' })
      }
    });
    expect(
      screen
        .getByRole('button', { name: 'Add reference' })
        .hasAttribute('disabled')
    ).toBe(true);
  });

  it('keeps an unresolved saved reference visible and deletable, without a stale numeric value', () => {
    const f = fixture();
    const withRef = addSketchReferenceDimension(f.document, {
      sketchId: f.sketchId,
      data: { dimensionKind: 'radius', objectId: f.sketch.objectIds[2]! }
    });
    const sketch = findSketch(withRef.document, f.sketchId)!;
    const onDelete = vi.fn<(command: AnyCommand) => void>();
    render(
      <SketchReferenceDimensions
        sketch={sketch}
        objects={f.objects.slice(0, 2)}
        units="mm"
        resolve={(v) => (typeof v === 'number' ? v : undefined)}
        disabled={false}

        onCommand={onDelete}
      />
    );
    const row = screen.getByRole('listitem');
    expect(within(row).getByText(/not part of this sketch/)).toBeTruthy();
    expect(within(row).getByText('Unresolved · Reference')).toBeTruthy();
    fireEvent.click(within(row).getByRole('button'));
    expect(onDelete.mock.calls[0]![0].payload).toMatchObject({
      annotationId: withRef.annotationId
    });
  });
});

function compositeFixture(polygon = false) {
  const shape = polygon
    ? inscribedPolygonShape({ x: 0, y: 0 }, { x: 0, y: 10 }, 6)!
    : cornerRectangleShape({ x: 0, y: 0 }, { x: 20, y: 12 })!;
  const commit = compositeCommands(shape, {
    kind: 'new-sketch',
    name: 'Composite references',
    planeRef: { type: 'canonical', plane: 'XY', offset: 0 }
  });
  const manager = new CommandManager(
    createProjectDocument('Composite references', toUserId('user_test'))
  );
  manager.execute(composeCommands(commit.label, commit.commands));
  const sketch = findSketch(manager.document, commit.sketchId)!;
  const objects = sketch.objectIds.map((id, index) => {
    const node = manager.document.nodes[id]!;
    if (node.kind !== 'sketch-object') throw new Error('Missing side');
    return { id, label: `Line ${index + 1}`, data: node.data };
  });
  return { manager, sketch, objects, composite: sketch.composites![0]! };
}

describe('composite reference targets', () => {
  it('authors projected distances with named corners and preserved topology', () => {
    const { sketch, objects, composite } = compositeFixture();
    const onCommand = vi.fn<(command: AnyCommand) => void>();
    render(
      <SketchReferenceDimensions
        sketch={sketch}
        objects={objects}
        units="mm"
        resolve={(value) => (typeof value === 'number' ? value : undefined)}
        disabled={false}
        onCommand={onCommand}
      />
    );
    const a = createSketchCompositeCornerTarget(composite, 0);
    const b = createSketchCompositeCornerTarget(composite, 2);
    expect(
      screen.getAllByRole('option', { name: 'Rectangle 1 · Corner 1' })
    ).toHaveLength(2);
    fireEvent.change(screen.getByLabelText('Distance type'), {
      target: { value: 'horizontal' }
    });
    fireEvent.change(screen.getByLabelText('Reference from'), {
      target: { value: JSON.stringify(a) }
    });
    fireEvent.change(screen.getByLabelText('Reference to'), {
      target: { value: JSON.stringify(b) }
    });
    expect(screen.getByRole('status').textContent).toBe('Measured: 20 mm');
    fireEvent.click(screen.getByRole('button', { name: 'Add reference' }));
    expect(onCommand.mock.calls[0]![0].payload).toMatchObject({
      data: { dimensionKind: 'distance', distanceMode: 'horizontal', a, b }
    });
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('mixes a logical corner with a primitive point and measures named sides', () => {
    const { sketch, objects, composite } = compositeFixture();
    const onCommand = vi.fn<(command: AnyCommand) => void>();
    render(
      <SketchReferenceDimensions
        sketch={sketch}
        objects={objects}
        units="mm"
        resolve={(value) => (typeof value === 'number' ? value : undefined)}
        disabled={false}
        onCommand={onCommand}
      />
    );
    const corner = createSketchCompositeCornerTarget(composite, 0);
    const primitive = { objectId: objects[0]!.id, point: 'end' };
    fireEvent.change(screen.getByLabelText('Reference from'), {
      target: { value: JSON.stringify(corner) }
    });
    fireEvent.change(screen.getByLabelText('Reference to'), {
      target: { value: JSON.stringify(primitive) }
    });
    expect(screen.getByRole('status').textContent).toBe('Measured: 20 mm');
    fireEvent.click(screen.getByRole('button', { name: 'Add reference' }));
    expect(onCommand.mock.calls[0]![0].payload).toMatchObject({
      data: { a: corner, b: primitive }
    });
    fireEvent.change(screen.getByLabelText('Reference type'), {
      target: { value: 'angle' }
    });
    const a = createSketchCompositeSideTarget(composite, 0);
    const b = createSketchCompositeSideTarget(composite, 1);
    fireEvent.change(screen.getByLabelText('Reference from'), {
      target: { value: JSON.stringify(a) }
    });
    fireEvent.change(screen.getByLabelText('Reference to'), {
      target: { value: JSON.stringify(b) }
    });
    expect(screen.getByRole('status').textContent).toBe('Measured: 90°');
    fireEvent.click(screen.getByRole('button', { name: 'Add reference' }));
    expect(onCommand.mock.calls[1]![0].payload).toMatchObject({
      data: { dimensionKind: 'angle', a, b }
    });
  });

  it('names polygon corners and keeps a missing composite reference removable', () => {
    const f = compositeFixture(true);
    const data = {
      dimensionKind: 'distance' as const,
      a: createSketchCompositeCornerTarget(f.composite, 0),
      b: createSketchCompositeCornerTarget(f.composite, 3)
    };
    const added = addSketchReferenceDimension(f.manager.document, {
      sketchId: f.sketch.sketchId,
      data
    });
    const sketch = findSketch(added.document, f.sketch.sketchId)!;
    const onCommand = vi.fn<(command: AnyCommand) => void>();
    const props = {
      sketch,
      objects: f.objects,
      units: 'mm',
      resolve: (value: number | string) =>
        typeof value === 'number' ? value : undefined,
      disabled: false,
      onCommand
    };
    const { rerender } = render(<SketchReferenceDimensions {...props} />);
    expect(
      screen.getAllByRole('option', { name: 'Polygon 1 · Corner 6' })
    ).toHaveLength(2);
    expect(screen.getByRole('listitem').textContent).toContain('Polygon 1');
    rerender(
      <SketchReferenceDimensions
        {...props}
        sketch={{ ...sketch, composites: [] }}
      />
    );
    const row = screen.getByRole('listitem');
    expect(within(row).getByText('Unresolved · Reference')).toBeTruthy();
    expect(within(row).queryByText('20 mm · Reference')).toBeNull();
    fireEvent.click(
      within(row).getByRole('button', { name: /^Delete Reference/ })
    );
    expect(onCommand.mock.calls[0]![0].payload).toMatchObject({
      annotationId: added.annotationId
    });
  });
});

describe('composite option budgets', () => {
  it.each(['shapes', 'targets'] as const)(
    'preserves primitive choices and a removable saved row when composite %s exceed the limit',
    (budget) => {
      const f = compositeFixture();
      const count = budget === 'shapes' ? SKETCH_SNAP_LIMITS.objects + 1 : 129;
      const records: SketchComposite[] = Array.from(
        { length: count },
        (_, index) => ({
          ...f.composite,
          compositeId: toSketchCompositeId(`scmp_broken_${index}`),
          ...(budget === 'targets'
            ? {
                compositeKind: 'polygon' as const,
                method: 'inscribed' as const,
                helperIds: [
                  `missing_helper_${index}` as (typeof f.composite.edgeIds)[number]
                ],
                edgeIds: Array.from(
                  { length: 64 },
                  (_, side) =>
                    `missing_${index}_${side}` as (typeof f.composite.edgeIds)[number]
                )
              }
            : {
                edgeIds: f.composite.edgeIds.map(
                  (_, side) =>
                    `missing_${index}_${side}` as (typeof f.composite.edgeIds)[number]
                )
              })
        })
      );
      const last = records.at(-1)!;
      const added = addSketchReferenceDimension(f.manager.document, {
        sketchId: f.sketch.sketchId,
        data: {
          dimensionKind: 'distance',
          a: createSketchCompositeCornerTarget(f.composite, 0),
          b: createSketchCompositeCornerTarget(f.composite, 2)
        }
      });
      const sketch = findSketch(added.document, f.sketch.sketchId)!;
      const saved = {
        ...sketch.referenceDimensions![0]!,
        data: {
          dimensionKind: 'distance' as const,
          a: createSketchCompositeCornerTarget(last, 0),
          b: createSketchCompositeCornerTarget(last, 2)
        }
      };
      const onCommand = vi.fn<(command: AnyCommand) => void>();
      render(
        <SketchReferenceDimensions
          sketch={{
            ...sketch,
            composites: records,
            referenceDimensions: [saved]
          }}
          objects={f.objects}
          units="mm"
          resolve={(value) => (typeof value === 'number' ? value : undefined)}
          disabled={false}
          onCommand={onCommand}
        />
      );
      expect(
        screen.getByText(/Composite targets are unavailable/)
      ).toBeTruthy();
      expect(
        screen.queryAllByRole('option', { name: /· Corner/ })
      ).toHaveLength(0);
      expect(
        screen.getAllByRole('option', { name: 'Line 1.start' })
      ).toHaveLength(2);
      const row = screen.getByRole('listitem');
      expect(row.textContent).toContain('Unresolved · Reference');
      if (budget === 'shapes')
        expect(row.textContent).toContain('Composite · Corner 1');
      fireEvent.click(
        within(row).getByRole('button', { name: /^Delete Reference/ })
      );
      expect(onCommand.mock.calls[0]![0].payload).toMatchObject({
        annotationId: saved.annotationId
      });
      fireEvent.change(screen.getByLabelText('Reference type'), {
        target: { value: 'angle' }
      });
      expect(screen.queryAllByRole('option', { name: /· Side/ })).toHaveLength(
        0
      );
      expect(screen.getAllByRole('option', { name: 'Line 1' })).toHaveLength(2);
    }
  );
});
