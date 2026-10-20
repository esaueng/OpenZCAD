import {
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from '@testing-library/react';
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
import { DrawingProjectionClient } from '../lib/drawing/projectionClient';
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
    geometryPending?: boolean;
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
      geometryPending={options.geometryPending ?? false}
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

  it('refuses a new sheet when every body is hidden, not draws the hidden ones', async () => {
    const base = createProjectDocument('Bracket', toUserId('test'));
    const onCommand = vi.fn((_command: AnyCommand) => true);
    const onStatus = vi.fn();
    render(
      <DrawingWorkspace
        document={{ ...base, bodyOrder: [bodyId] }}
        bodies={{ [bodyId]: cube() }}
        geometryPending={false}
        defaultBodyIds={[]}
        editDisabledReason={null}
        onCommand={onCommand}
        onStatus={onStatus}
      />
    );
    await userEvent.click(
      screen.getByRole('button', { name: /New drawing sheet/ })
    );
    expect(onCommand).not.toHaveBeenCalled();
    expect(onStatus).toHaveBeenCalledWith(
      'Show at least one body to make a drawing of it.'
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

  it('retries the views after the projection worker fails', async () => {
    const original = DrawingProjectionClient.prototype.project;
    const project = vi
      .spyOn(DrawingProjectionClient.prototype, 'project')
      .mockImplementationOnce(() =>
        Promise.reject(new Error('The drawing projection worker stopped.'))
      )
      .mockImplementation(function (this: DrawingProjectionClient, ...args) {
        return original.apply(this, args);
      });
    try {
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
      expect(project).toHaveBeenCalledTimes(2);
      expect(canvas.textContent).not.toMatch(/worker stopped/);
    } finally {
      project.mockRestore();
    }
  });

  it("adds a projected view on its projection angle's side of the base", async () => {
    const fingerprint = drawingSourceFingerprint({ [bodyId]: cube() }, [
      bodyId
    ])!;
    const sheet = {
      ...starter(fingerprint),
      projectionAngle: 'third' as const
    };
    const front = sheet.views[0]!;
    const { onCommand } = setup({ sheet });
    await userEvent.selectOptions(screen.getByLabelText('New view'), 'bottom');
    await userEvent.click(screen.getByRole('button', { name: /Add view/ }));
    const { view } = onCommand.mock.calls[0]![0].payload as {
      view: DrawingSheet['views'][number];
    };
    expect(view.parentViewId).toBe(front.viewId);
    expect(view.centerMm.x).toBeCloseTo(front.centerMm.x, 9);
    // Third angle: the bottom view sits below the front, clear of it.
    expect(view.centerMm.y).toBeLessThan(front.centerMm.y - 15);
  });

  it('keeps the keys it handles from the workspace shortcuts', async () => {
    const fingerprint = drawingSourceFingerprint({ [bodyId]: cube() }, [
      bodyId
    ])!;
    const { onCommand } = setup({ sheet: starter(fingerprint) });
    const reached = vi.fn();
    window.addEventListener('keydown', reached);
    try {
      await userEvent.click(screen.getByRole('button', { name: 'Front view' }));
      screen.getByRole('application', { name: 'Sheet Sheet 1' }).focus();
      await userEvent.keyboard('{ArrowRight}{Delete}');
      expect(onCommand.mock.calls.map(([command]) => command.kind)).toEqual([
        'drawing.view.update',
        'drawing.view.delete'
      ]);
      expect(reached).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', reached);
    }
  });

  it('waits, rather than drawing or exporting, while the model rebuilds', () => {
    // The completed geometry still matches the sheet, but the document has
    // moved on: it is not the model to draw or export.
    const fingerprint = drawingSourceFingerprint({ [bodyId]: cube() }, [
      bodyId
    ])!;
    setup({ sheet: starter(fingerprint), geometryPending: true });
    expect(screen.getByRole('status').textContent).toMatch(
      /Waiting for the model/
    );
    const canvas = screen.getByRole('application', { name: 'Sheet Sheet 1' });
    expect(
      canvas.querySelectorAll('.drawing-view.is-placeholder')
    ).toHaveLength(4);
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'PDF' }).disabled
    ).toBe(true);
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

  it('waits rather than calling a body missing while the model rebuilds', async () => {
    // Reload or undo: the document names a body the last completed geometry
    // does not have yet.
    const sheet = starter('v1:0000000000000000');
    sheet.views[0]!.bodyIds = [bodyId, 'body_back' as BodyId];
    setup({ sheet, geometryPending: true });
    expect(screen.getByRole('status').textContent).toMatch(
      /Waiting for the model/
    );
    await userEvent.click(screen.getByRole('button', { name: 'Front view' }));
    const pending = screen.getByRole<HTMLInputElement>('checkbox', {
      name: 'Body (updating…)'
    });
    expect(pending.disabled).toBe(true);
  });

  it('lists every view, so one off the page can still be picked', async () => {
    const fingerprint = drawingSourceFingerprint({ [bodyId]: cube() }, [
      bodyId
    ])!;
    const sheet = starter(fingerprint);
    // An older document, or a smaller sheet: the isometric left off the page.
    sheet.views[3]!.centerMm = { x: 900, y: 150 };
    setup({ sheet });
    const list = screen.getByRole('listbox', { name: 'Views on this sheet' });
    const off = within(list).getByRole('option', {
      name: 'Isometric (off the page)'
    });
    await userEvent.click(off);
    expect(
      screen.getByRole<HTMLInputElement>('spinbutton', {
        name: 'Centre X (mm)'
      }).value
    ).toBe('900.0');
  });

  it('drops a drag whose view is deleted before the pointer is released', () => {
    const fingerprint = drawingSourceFingerprint({ [bodyId]: cube() }, [
      bodyId
    ])!;
    const sheet = starter(fingerprint);
    const base = createProjectDocument('Bracket', toUserId('test'));
    const document = (sheets: DrawingSheet[]): ProjectDocument => ({
      ...base,
      bodyOrder: [bodyId],
      drawings: { sheets }
    });
    const onCommand = vi.fn((_command: AnyCommand) => true);
    const rect = vi
      .spyOn(Element.prototype, 'getBoundingClientRect')
      .mockReturnValue(new DOMRect(0, 0, 840, 594));
    const props = {
      bodies: { [bodyId]: cube() },
      geometryPending: false,
      defaultBodyIds: [bodyId],
      editDisabledReason: null,
      onCommand,
      onStatus: vi.fn()
    };
    const { rerender } = render(
      <DrawingWorkspace document={document([sheet])} {...props} />
    );
    const iso = screen.getByRole('button', { name: 'Isometric view' });
    fireEvent.pointerDown(iso, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(iso, { clientX: 140, clientY: 100 });
    // Delete (or an undo, or a collaborator) removes the view mid-drag.
    const without = {
      ...sheet,
      views: sheet.views.filter((view) => view.orientation !== 'iso')
    };
    rerender(<DrawingWorkspace document={document([without])} {...props} />);
    expect(
      screen.getByRole('application', { name: 'Sheet Sheet 1' })
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Isometric view' })).toBeNull();
    fireEvent.pointerUp(screen.getByRole('button', { name: 'Front view' }));
    expect(onCommand).not.toHaveBeenCalled();
    rect.mockRestore();
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
