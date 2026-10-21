import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  addSketchFeature,
  addSketchReferenceDimension,
  createProjectDocument,
  findSketch
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import { SketchReferenceDimensions } from './SketchReferenceDimensions';
import type { AnyCommand } from '@openzcad/command-system';

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
