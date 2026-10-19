import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AnyCommand } from '@openzcad/command-system';
import { createProjectDocument } from '@openzcad/document-core';
import {
  toUserId,
  type BodyId,
  type BodyRepresentation,
  type DrawingSheet,
  type ProjectDocument
} from '@openzcad/shared';
import { DrawingWorkspace } from './DrawingWorkspace';
import {
  createStarterSheet,
  drawingSourceFingerprint
} from '../lib/drawing/sheetSources';

const bodyId = 'body_cube' as BodyId;

/** A 10 mm cube at the origin with outward-wound faces and its 12 edges. */
function cube(size = 10): BodyRepresentation {
  const s = size;
  const corners = [
    [0, 0, 0],
    [s, 0, 0],
    [s, s, 0],
    [0, s, 0],
    [0, 0, s],
    [s, 0, s],
    [s, s, s],
    [0, s, s]
  ];
  const quads = [
    [0, 3, 2, 1],
    [4, 5, 6, 7],
    [0, 1, 5, 4],
    [2, 3, 7, 6],
    [1, 2, 6, 5],
    [0, 4, 7, 3]
  ];
  const indices = quads.flatMap(([a, b, c, d]) => [a!, b!, c!, a!, c!, d!]);
  const edgePairs = [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 0],
    [4, 5],
    [5, 6],
    [6, 7],
    [7, 4],
    [0, 4],
    [1, 5],
    [2, 6],
    [3, 7]
  ];
  return {
    bodyId,
    name: 'Cube',
    source: 'primitive',
    mesh: {
      kind: 'mesh',
      vertices: Float32Array.from(corners.flat()),
      indices: Uint32Array.from(indices)
    },
    faceCount: 6,
    color: '#888888',
    exportableStep: true,
    consumed: false,
    volume: s ** 3,
    bbox: { min: { x: 0, y: 0, z: 0 }, max: { x: s, y: s, z: s } },
    topology: {
      faces: quads.map((_, index) => ({
        topologyId: `f${index}`,
        hash: 100 + index,
        triangleStart: index * 2,
        triangleCount: 2
      })),
      edges: edgePairs.map(([a, b], index) => ({
        topologyId: `e${index}`,
        hash: 200 + index + s,
        points: [...corners[a!]!, ...corners[b!]!]
      }))
    }
  };
}

function setup(
  options: {
    sheet?: DrawingSheet;
    size?: number;
    editDisabledReason?: string | null;
  } = {}
) {
  const base = createProjectDocument('Bracket', toUserId('test'));
  const document: ProjectDocument = {
    ...base,
    bodyOrder: [bodyId],
    ...(options.sheet ? { drawings: { sheets: [options.sheet] } } : {})
  };
  const bodies = { [bodyId]: cube(options.size) };
  const onCommand = vi.fn((_command: AnyCommand) => true);
  const onStatus = vi.fn();
  render(
    <DrawingWorkspace
      document={document}
      bodies={bodies}
      defaultBodyIds={[bodyId]}
      editDisabledReason={options.editDisabledReason ?? null}
      onCommand={onCommand}
      onStatus={onStatus}
    />
  );
  return { onCommand, onStatus };
}

function starter(fingerprint: string): DrawingSheet {
  return createStarterSheet({
    name: 'Sheet 1',
    bodyIds: [bodyId],
    bodies: { [bodyId]: cube() },
    units: 'mm',
    paper: { size: 'A3', orientation: 'landscape' },
    projectionAngle: 'first',
    fingerprint
  });
}

describe('DrawingWorkspace', () => {
  it('starts a sheet with the four standard views, fenced to the model', async () => {
    const { onCommand } = setup();
    await userEvent.click(
      screen.getByRole('button', { name: /New drawing sheet/ })
    );
    expect(onCommand).toHaveBeenCalledTimes(1);
    const command = onCommand.mock.calls[0]![0];
    expect(command.kind).toBe('drawing.sheet.add');
    const { sheet } = command.payload as { sheet: DrawingSheet };
    expect(sheet.views.map((view) => view.orientation)).toEqual([
      'front',
      'top',
      'left',
      'iso'
    ]);
    expect(sheet.source.fingerprint).toBe(
      drawingSourceFingerprint({ [bodyId]: cube() }, [bodyId])
    );
  });

  it('refuses to start a sheet where the project is read-only', () => {
    setup({ editDisabledReason: 'This shared project is read-only' });
    expect(
      screen.getByRole<HTMLButtonElement>('button', {
        name: /New drawing sheet/
      }).disabled
    ).toBe(true);
  });

  it('draws a current sheet and allows export', async () => {
    const fingerprint = drawingSourceFingerprint({ [bodyId]: cube() }, [
      bodyId
    ])!;
    setup({ sheet: starter(fingerprint) });
    const canvas = screen.getByRole('application', { name: 'Sheet Sheet 1' });
    await waitFor(() =>
      expect(
        canvas.querySelectorAll('.drawing-view.is-placeholder')
      ).toHaveLength(0)
    );
    expect(
      canvas.querySelectorAll('.drawing-strokes.is-visible polyline').length
    ).toBeGreaterThan(0);
    expect(screen.queryByRole('status')).toBeNull();
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'PDF' }).disabled
    ).toBe(false);
  });

  it('shows a stale sheet as outlines, refuses export and rebinds on Update', async () => {
    const before = drawingSourceFingerprint({ [bodyId]: cube() }, [bodyId])!;
    const { onCommand } = setup({ sheet: starter(before), size: 12 });
    const banner = screen.getByRole('status');
    expect(banner.textContent).toMatch(
      /model changed since this sheet was drawn/
    );
    const canvas = screen.getByRole('application', { name: 'Sheet Sheet 1' });
    expect(
      canvas.querySelectorAll('.drawing-view.is-placeholder')
    ).toHaveLength(4);
    expect(
      canvas.querySelectorAll('.drawing-strokes.is-visible polyline')
    ).toHaveLength(0);
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'PDF' }).disabled
    ).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: /Update/ }));
    const command = onCommand.mock.calls[0]![0];
    expect(command.kind).toBe('drawing.sheet.update');
    expect(command.payload).toMatchObject({
      source: {
        fingerprint: drawingSourceFingerprint({ [bodyId]: cube(12) }, [bodyId])
      }
    });
  });

  it('lists a deleted body in its view so it can be removed', async () => {
    const sheet = starter('v1:0000000000000000');
    sheet.views[0]!.bodyIds = [bodyId, 'body_gone' as BodyId];
    const { onCommand } = setup({ sheet });
    await userEvent.click(screen.getByRole('button', { name: 'Front view' }));
    const gone = screen.getByRole('checkbox', {
      name: 'Deleted body (no longer in the model)'
    });
    expect((gone as HTMLInputElement).checked).toBe(true);
    await userEvent.click(gone);
    const command = onCommand.mock.calls[0]![0];
    expect(command.kind).toBe('drawing.view.update');
    expect(command.payload).toMatchObject({ bodyIds: [bodyId] });
  });

  it('names a body the sheet draws that is gone', () => {
    const sheet = starter('v1:0000000000000000');
    sheet.views[0]!.bodyIds = ['body_gone' as BodyId];
    setup({ sheet });
    expect(screen.getByRole('status').textContent).toMatch(
      /a deleted body, which no longer exists/
    );
  });
});
