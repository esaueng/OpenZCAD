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
  type DrawingAnnotation,
  type DrawingAnnotationId,
  type DrawingSheet,
  type ProjectDocument
} from '@openzcad/shared';
import { DrawingWorkspace } from './DrawingWorkspace';
import { DrawingProjectionClient } from '../lib/drawing/projectionClient';
import {
  createStarterSheet,
  drawingSourceFingerprint,
  projectionBodyInput
} from '../lib/drawing/sheetSources';
import type { ProjectionBodyInput } from '../lib/drawing/projectView';
import type * as SheetSources from '../lib/drawing/sheetSources';

// Pass-through, counted: fingerprinting is the costly step a drag must skip.
vi.mock('../lib/drawing/sheetSources', async (importOriginal) => {
  const actual = await importOriginal<typeof SheetSources>();
  return {
    ...actual,
    drawingSourceFingerprint: vi.fn(actual.drawingSourceFingerprint)
  };
});

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

/**
 * The geometry worker's canonical tessellation, stood in for by each body's
 * display mesh: these synthetic cubes have no exact geometry to mesh.
 */
function displayTessellation(
  bodies: Record<string, BodyRepresentation>
): (
  document: ProjectDocument,
  bodyIds: BodyId[]
) => Promise<Record<string, ProjectionBodyInput>> {
  return (_document, bodyIds) =>
    Promise.resolve(
      Object.fromEntries(
        bodyIds.flatMap((id) => {
          const input = bodies[id] ? projectionBodyInput(bodies[id]) : null;
          return input ? [[id, input]] : [];
        })
      )
    );
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
      requestTessellation={displayTessellation(bodies)}
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
        requestTessellation={displayTessellation({ [bodyId]: cube() })}
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
      requestTessellation: displayTessellation({ [bodyId]: cube() }),
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

  it('fingerprints the model once, not on every pointer move of a drag', () => {
    const fingerprint = drawingSourceFingerprint({ [bodyId]: cube() }, [
      bodyId
    ])!;
    const rect = vi
      .spyOn(Element.prototype, 'getBoundingClientRect')
      .mockReturnValue(new DOMRect(0, 0, 840, 594));
    try {
      setup({ sheet: starter(fingerprint) });
      const counted = vi.mocked(drawingSourceFingerprint);
      counted.mockClear();
      const iso = screen.getByRole('button', { name: 'Isometric view' });
      fireEvent.pointerDown(iso, { button: 0, clientX: 100, clientY: 100 });
      for (let step = 1; step <= 5; step += 1)
        fireEvent.pointerMove(iso, { clientX: 100 + step * 10, clientY: 100 });
      expect(counted).not.toHaveBeenCalled();
    } finally {
      rect.mockRestore();
    }
  });

  it('frees the projection of a view intent no sheet draws any more', async () => {
    const project = vi.spyOn(DrawingProjectionClient.prototype, 'project');
    try {
      const fingerprint = drawingSourceFingerprint({ [bodyId]: cube() }, [
        bodyId
      ])!;
      const sheet = starter(fingerprint);
      const base = createProjectDocument('Bracket', toUserId('test'));
      const document = (shown: DrawingSheet): ProjectDocument => ({
        ...base,
        bodyOrder: [bodyId],
        drawings: { sheets: [shown] }
      });
      const props = {
        bodies: { [bodyId]: cube() },
        geometryPending: false,
        defaultBodyIds: [bodyId],
        requestTessellation: displayTessellation({ [bodyId]: cube() }),
        editDisabledReason: null,
        onCommand: vi.fn(() => true),
        onStatus: vi.fn()
      };
      const settled = () =>
        waitFor(() =>
          expect(
            screen
              .getByRole('application', { name: 'Sheet Sheet 1' })
              .querySelectorAll('.drawing-view.is-placeholder')
          ).toHaveLength(0)
        );
      const { rerender } = render(
        <DrawingWorkspace document={document(sheet)} {...props} />
      );
      await settled();
      const toggled = {
        ...sheet,
        views: sheet.views.map((view, index) =>
          index === 3 ? { ...view, hiddenLines: !view.hiddenLines } : view
        )
      };
      rerender(<DrawingWorkspace document={document(toggled)} {...props} />);
      await settled();
      // Back to the first setting: its projection was freed with the
      // intent, so it is asked for again rather than kept for ever.
      rerender(<DrawingWorkspace document={document(sheet)} {...props} />);
      await settled();
      await waitFor(() => expect(project).toHaveBeenCalledTimes(3));
    } finally {
      project.mockRestore();
    }
  });

  it('projects from the canonical tessellation, meshed once per model, never the display mesh', async () => {
    const project = vi.spyOn(DrawingProjectionClient.prototype, 'project');
    try {
      const fingerprint = drawingSourceFingerprint({ [bodyId]: cube() }, [
        bodyId
      ])!;
      const sheet = starter(fingerprint);
      const base = createProjectDocument('Bracket', toUserId('test'));
      const document = (shown: DrawingSheet): ProjectDocument => ({
        ...base,
        bodyOrder: [bodyId],
        drawings: { sheets: [shown] }
      });
      // Told apart by size: the display mesh is the 10 mm cube, the
      // canonical tessellation a 12 mm one.
      const canonical = displayTessellation({ [bodyId]: cube(12) });
      const requestTessellation = vi.fn(canonical);
      const props = {
        bodies: { [bodyId]: cube() },
        geometryPending: false,
        defaultBodyIds: [bodyId],
        requestTessellation,
        editDisabledReason: null,
        onCommand: vi.fn(() => true),
        onStatus: vi.fn()
      };
      const settled = () =>
        waitFor(() =>
          expect(
            screen
              .getByRole('application', { name: 'Sheet Sheet 1' })
              .querySelectorAll('.drawing-view.is-placeholder')
          ).toHaveLength(0)
        );
      const { rerender } = render(
        <DrawingWorkspace document={document(sheet)} {...props} />
      );
      await settled();
      expect(requestTessellation).toHaveBeenCalledTimes(1);
      expect(requestTessellation.mock.calls[0]![1]).toEqual([bodyId]);
      const [inputs] = project.mock.calls[0]!;
      expect(Math.max(...inputs[bodyId]!.vertices)).toBe(12);
      // A hidden-line toggle projects again from the same tessellation.
      rerender(
        <DrawingWorkspace
          document={document({
            ...sheet,
            views: sheet.views.map((view, index) =>
              index === 0 ? { ...view, hiddenLines: !view.hiddenLines } : view
            )
          })}
          {...props}
        />
      );
      await settled();
      await waitFor(() => expect(project).toHaveBeenCalledTimes(2));
      expect(requestTessellation).toHaveBeenCalledTimes(1);
    } finally {
      project.mockRestore();
    }
  });

  it('shows the refusal when the model cannot be meshed for drawing', async () => {
    const fingerprint = drawingSourceFingerprint({ [bodyId]: cube() }, [
      bodyId
    ])!;
    const base = createProjectDocument('Bracket', toUserId('test'));
    const requestTessellation = vi.fn(() =>
      Promise.reject(new Error('Body body_cube has no exact geometry to draw.'))
    );
    render(
      <DrawingWorkspace
        document={{
          ...base,
          bodyOrder: [bodyId],
          drawings: { sheets: [starter(fingerprint)] }
        }}
        bodies={{ [bodyId]: cube() }}
        geometryPending={false}
        defaultBodyIds={[bodyId]}
        requestTessellation={requestTessellation}
        editDisabledReason={null}
        onCommand={vi.fn(() => true)}
        onStatus={vi.fn()}
      />
    );
    // Two retries, then the views say why rather than asking for ever.
    await waitFor(() =>
      expect(
        screen.getAllByText(/has no exact geometry to draw/).length
      ).toBeGreaterThan(0)
    );
    expect(requestTessellation).toHaveBeenCalledTimes(3);
  });

  it('abandons a tessellation still in the geometry worker when the workspace closes', async () => {
    const fingerprint = drawingSourceFingerprint({ [bodyId]: cube() }, [
      bodyId
    ])!;
    const base = createProjectDocument('Bracket', toUserId('test'));
    const signals: AbortSignal[] = [];
    // Never answers: the model is still meshing when Draw closes.
    const requestTessellation = vi.fn(
      (_document: ProjectDocument, _bodyIds: BodyId[], signal: AbortSignal) => {
        signals.push(signal);
        return new Promise<Record<string, ProjectionBodyInput>>(() => {});
      }
    );
    const { unmount } = render(
      <DrawingWorkspace
        document={{
          ...base,
          bodyOrder: [bodyId],
          drawings: { sheets: [starter(fingerprint)] }
        }}
        bodies={{ [bodyId]: cube() }}
        geometryPending={false}
        defaultBodyIds={[bodyId]}
        requestTessellation={requestTessellation}
        editDisabledReason={null}
        onCommand={vi.fn(() => true)}
        onStatus={vi.fn()}
      />
    );
    await waitFor(() => expect(requestTessellation).toHaveBeenCalled());
    expect(signals.every((signal) => !signal.aborted)).toBe(true);
    unmount();
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it("keeps each sheet's projections when switching between sheets of different bodies", async () => {
    const otherId = 'body_other' as BodyId;
    const other = { ...cube(4), bodyId: otherId, name: 'Small cube' };
    const bodies = { [bodyId]: cube(), [otherId]: other };
    const first = starter(drawingSourceFingerprint(bodies, [bodyId])!);
    const second = createStarterSheet({
      name: 'Sheet 2',
      bodyIds: [otherId],
      bodies,
      units: 'mm',
      paper: { size: 'A3', orientation: 'landscape' },
      projectionAngle: 'first',
      fingerprint: drawingSourceFingerprint(bodies, [otherId])!
    });
    const project = vi.spyOn(DrawingProjectionClient.prototype, 'project');
    try {
      const base = createProjectDocument('Bracket', toUserId('test'));
      render(
        <DrawingWorkspace
          document={{
            ...base,
            bodyOrder: [bodyId, otherId],
            drawings: { sheets: [first, second] }
          }}
          bodies={bodies}
          geometryPending={false}
          defaultBodyIds={[bodyId]}
          requestTessellation={displayTessellation(bodies)}
          editDisabledReason={null}
          onCommand={vi.fn(() => true)}
          onStatus={vi.fn()}
        />
      );
      const settled = (name: string) =>
        waitFor(() =>
          expect(
            screen
              .getByRole('application', { name: `Sheet ${name}` })
              .querySelectorAll('.drawing-view.is-placeholder')
          ).toHaveLength(0)
        );
      const list = screen.getByRole('listbox', { name: 'Drawing sheets' });
      await settled('Sheet 1');
      await userEvent.click(
        within(list).getByRole('option', { name: 'Sheet 2' })
      );
      await settled('Sheet 2');
      await userEvent.click(
        within(list).getByRole('option', { name: 'Sheet 1' })
      );
      await settled('Sheet 1');
      // One request per sheet: going back to the first reuses its views.
      expect(project).toHaveBeenCalledTimes(2);
    } finally {
      project.mockRestore();
    }
  });

  it('offers the large-model scales, so a fitted 1:500 can be picked again', () => {
    const fingerprint = drawingSourceFingerprint({ [bodyId]: cube() }, [
      bodyId
    ])!;
    setup({ sheet: starter(fingerprint) });
    const scale = screen.getByRole<HTMLSelectElement>('combobox', {
      name: 'Scale'
    });
    const options = Array.from(scale.options, (option) => option.value);
    expect(options).toEqual(
      expect.arrayContaining(['1:200', '1:500', '1:1000'])
    );
  });

  it('frees the projections of the last sheet when it is deleted', async () => {
    const project = vi.spyOn(DrawingProjectionClient.prototype, 'project');
    try {
      const sheet = starter(
        drawingSourceFingerprint({ [bodyId]: cube() }, [bodyId])!
      );
      const base = createProjectDocument('Bracket', toUserId('test'));
      const document = (sheets: DrawingSheet[]): ProjectDocument => ({
        ...base,
        bodyOrder: [bodyId],
        ...(sheets.length > 0 ? { drawings: { sheets } } : {})
      });
      const props = {
        bodies: { [bodyId]: cube() },
        geometryPending: false,
        defaultBodyIds: [bodyId],
        requestTessellation: displayTessellation({ [bodyId]: cube() }),
        editDisabledReason: null,
        onCommand: vi.fn(() => true),
        onStatus: vi.fn()
      };
      const settled = () =>
        waitFor(() =>
          expect(
            screen
              .getByRole('application', { name: 'Sheet Sheet 1' })
              .querySelectorAll('.drawing-view.is-placeholder')
          ).toHaveLength(0)
        );
      const { rerender } = render(
        <DrawingWorkspace document={document([sheet])} {...props} />
      );
      await settled();
      rerender(<DrawingWorkspace document={document([])} {...props} />);
      // Undo brings the sheet back: its projections were freed with it, so
      // they are asked for again rather than kept for as long as Draw is open.
      rerender(<DrawingWorkspace document={document([sheet])} {...props} />);
      await settled();
      await waitFor(() => expect(project).toHaveBeenCalledTimes(2));
    } finally {
      project.mockRestore();
    }
  });

  it("asks for a view's bodies in key order, whatever order the view stores", async () => {
    const otherId = 'body_a_first' as BodyId;
    const bodies = {
      [bodyId]: cube(),
      [otherId]: { ...cube(4), bodyId: otherId, name: 'Small cube' }
    };
    const sheet = starter(drawingSourceFingerprint(bodies, [bodyId, otherId])!);
    // Removed and re-added: the stored order differs from the sorted key.
    sheet.views = sheet.views.map((view) => ({
      ...view,
      bodyIds: [bodyId, otherId]
    }));
    const project = vi.spyOn(DrawingProjectionClient.prototype, 'project');
    try {
      const base = createProjectDocument('Bracket', toUserId('test'));
      render(
        <DrawingWorkspace
          document={{
            ...base,
            bodyOrder: [bodyId, otherId],
            drawings: { sheets: [sheet] }
          }}
          bodies={bodies}
          geometryPending={false}
          defaultBodyIds={[bodyId]}
          requestTessellation={displayTessellation(bodies)}
          editDisabledReason={null}
          onCommand={vi.fn(() => true)}
          onStatus={vi.fn()}
        />
      );
      await waitFor(() => expect(project).toHaveBeenCalled());
      const [, views] = project.mock.calls[0]!;
      for (const view of views) expect(view.bodyIds).toEqual([otherId, bodyId]);
    } finally {
      project.mockRestore();
    }
  });

  it('fingerprints each body set once across sheets and drawing edits', () => {
    const fingerprint = drawingSourceFingerprint({ [bodyId]: cube() }, [
      bodyId
    ])!;
    const sheets = Array.from({ length: 5 }, (_, index) => ({
      ...starter(fingerprint),
      name: `Sheet ${index + 1}`
    }));
    const base = createProjectDocument('Bracket', toUserId('test'));
    const document = (entries: DrawingSheet[]): ProjectDocument => ({
      ...base,
      bodyOrder: [bodyId],
      drawings: { sheets: entries }
    });
    const props = {
      bodies: { [bodyId]: cube() },
      geometryPending: false,
      defaultBodyIds: [bodyId],
      requestTessellation: displayTessellation({ [bodyId]: cube() }),
      editDisabledReason: null,
      onCommand: vi.fn(() => true),
      onStatus: vi.fn()
    };
    const counted = vi.mocked(drawingSourceFingerprint);
    counted.mockClear();
    const { rerender } = render(
      <DrawingWorkspace document={document(sheets)} {...props} />
    );
    // Five sheets of one body: one fingerprint.
    expect(counted).toHaveBeenCalledTimes(1);
    // A drawing edit (a rename) replaces every sheet object: still none new.
    rerender(
      <DrawingWorkspace
        document={document(
          sheets.map((entry, index) =>
            index === 0 ? { ...entry, name: 'Renamed' } : { ...entry }
          )
        )}
        {...props}
      />
    );
    expect(counted).toHaveBeenCalledTimes(1);
    // New bodies (a model edit) fingerprint again.
    rerender(
      <DrawingWorkspace
        document={document(sheets)}
        {...props}
        bodies={{ [bodyId]: cube() }}
      />
    );
    expect(counted).toHaveBeenCalledTimes(2);
  });

  it('names a body the sheet draws that is gone', () => {
    const sheet = starter('v1:0000000000000000');
    sheet.views[0]!.bodyIds = ['body_gone' as BodyId];
    setup({ sheet });
    expect(screen.getByRole('status').textContent).toMatch(
      /a deleted body, which no longer exists/
    );
  });

  describe('D02 annotations', () => {
    /** The cube's bottom front edge, (0,0,0)–(10,0,0): 10 mm across. */
    function dimensioned(hash = 210): DrawingSheet {
      const sheet = starter(
        drawingSourceFingerprint({ [bodyId]: cube() }, [bodyId])!
      );
      const front = sheet.views.find((view) => view.orientation === 'front')!;
      const annotation: DrawingAnnotation = {
        annotationId: 'dann_w' as DrawingAnnotationId,
        kind: 'linear',
        viewId: front.viewId,
        direction: 'horizontal',
        from: { edge: { bodyId, hash }, anchor: 'first' },
        to: { edge: { bodyId, hash }, anchor: 'second' },
        placementMm: { x: 0, y: -15 }
      };
      return { ...sheet, annotations: [annotation] };
    }

    it('draws a dimension with its value read from the model', async () => {
      setup({ sheet: dimensioned() });
      const canvas = screen.getByRole('application', {
        name: 'Sheet Sheet 1'
      });
      expect(
        await within(canvas).findByRole('button', {
          name: 'Horizontal dimension 10'
        })
      ).toBeTruthy();
      expect(
        canvas.querySelectorAll(
          '.drawing-strokes.is-dimension polygon.is-filled'
        )
      ).toHaveLength(2);
      expect(
        within(
          screen.getByRole('listbox', { name: 'Annotations on this sheet' })
        ).getByRole('option', { name: 'Horizontal dimension 10' })
      ).toBeTruthy();
      expect(
        screen.getByRole<HTMLButtonElement>('button', { name: 'PDF' }).disabled
      ).toBe(false);
    });

    it('keeps a broken dimension in place, refuses export and offers a re-pick', async () => {
      const { onCommand } = setup({ sheet: dimensioned(999) });
      const canvas = screen.getByRole('application', {
        name: 'Sheet Sheet 1'
      });
      await waitFor(() =>
        expect(canvas.textContent).toContain('Broken dimension')
      );
      expect(
        screen.getByRole<HTMLButtonElement>('button', { name: 'PDF' }).disabled
      ).toBe(true);
      expect(document.body.textContent).toMatch(
        /An annotation has lost what it measures/
      );
      await userEvent.click(
        screen.getByRole('option', { name: 'Horizontal dimension (broken)' })
      );
      expect(screen.getByRole('alert').textContent).toMatch(/no longer exists/);
      await userEvent.click(screen.getByRole('button', { name: /Re-pick/ }));
      expect(screen.getByText(/Horizontal dimension: pick/)).toBeTruthy();
      await userEvent.click(screen.getByRole('button', { name: /^Delete$/ }));
      const command = onCommand.mock.calls.at(-1)![0];
      expect(command.kind).toBe('drawing.annotation.delete');
      expect(command.payload).toMatchObject({ annotationId: 'dann_w' });
    });

    it('shows no value and offers no tool until a stale sheet is updated', () => {
      setup({ sheet: dimensioned(), size: 12 });
      expect(
        screen.getByRole('option', { name: 'Horizontal dimension' })
      ).toBeTruthy();
      expect(
        screen.queryByRole('button', { name: /^Horizontal dimension/ })
      ).toBeNull();
      expect(
        screen.getByRole<HTMLButtonElement>('button', { name: 'Horizontal' })
          .disabled
      ).toBe(true);
    });

    it("ends a tool when another sheet takes the active one's place", async () => {
      const first = dimensioned();
      const second = { ...dimensioned(), name: 'Sheet 2' };
      const base = createProjectDocument('Bracket', toUserId('test'));
      const props = {
        bodies: { [bodyId]: cube() },
        requestTessellation: displayTessellation({ [bodyId]: cube() }),
        geometryPending: false,
        defaultBodyIds: [bodyId],
        editDisabledReason: null,
        onCommand: vi.fn((_command: AnyCommand) => true),
        onStatus: vi.fn()
      };
      const documentWith = (sheet: DrawingSheet): ProjectDocument => ({
        ...base,
        bodyOrder: [bodyId],
        drawings: { sheets: [sheet] }
      });
      const { rerender } = render(
        <DrawingWorkspace document={documentWith(first)} {...props} />
      );
      await userEvent.click(screen.getByRole('button', { name: 'Vertical' }));
      expect(document.querySelector('.drawing-pick-surface')).not.toBeNull();
      // An undo or a collaborator replaces the sheet with another, ready one.
      rerender(<DrawingWorkspace document={documentWith(second)} {...props} />);
      await waitFor(() =>
        expect(document.querySelector('.drawing-pick-surface')).toBeNull()
      );
      expect(screen.queryByText(/Vertical dimension: pick/)).toBeNull();
    });

    it('offers paper notes, but no dimensions, on a ready sheet with no views', () => {
      const sheet = {
        ...starter(drawingSourceFingerprint({}, [])!),
        views: []
      };
      setup({ sheet });
      expect(
        screen.getByRole<HTMLButtonElement>('button', { name: 'Note' }).disabled
      ).toBe(false);
      expect(
        screen.getByRole<HTMLButtonElement>('button', { name: 'Horizontal' })
          .disabled
      ).toBe(true);
    });

    it('ends a tool when its view stops drawing what was picked', async () => {
      const sheet = dimensioned(999);
      const viewId = sheet.annotations![0]!.viewId!;
      const base = createProjectDocument('Bracket', toUserId('test'));
      const props = {
        bodies: { [bodyId]: cube() },
        requestTessellation: displayTessellation({ [bodyId]: cube() }),
        geometryPending: false,
        defaultBodyIds: [bodyId],
        editDisabledReason: null,
        onCommand: vi.fn((_command: AnyCommand) => true),
        onStatus: vi.fn()
      };
      const documentWith = (entry: DrawingSheet): ProjectDocument => ({
        ...base,
        bodyOrder: [bodyId],
        drawings: { sheets: [entry] }
      });
      const { rerender } = render(
        <DrawingWorkspace document={documentWith(sheet)} {...props} />
      );
      await userEvent.click(
        screen.getByRole('option', { name: 'Horizontal dimension (broken)' })
      );
      await userEvent.click(screen.getByRole('button', { name: /Re-pick/ }));
      expect(document.querySelector('.drawing-pick-surface')).not.toBeNull();
      // The same view, same sheet, still ready, with its hidden lines toggled.
      const toggled: DrawingSheet = {
        ...sheet,
        views: sheet.views.map((view) =>
          view.viewId === viewId
            ? { ...view, hiddenLines: !view.hiddenLines }
            : view
        )
      };
      rerender(
        <DrawingWorkspace document={documentWith(toggled)} {...props} />
      );
      await waitFor(() =>
        expect(document.querySelector('.drawing-pick-surface')).toBeNull()
      );
    });

    it('ends a tool when the view it picks in is deleted', async () => {
      const sheet = dimensioned(999);
      const viewId = sheet.annotations![0]!.viewId!;
      const base = createProjectDocument('Bracket', toUserId('test'));
      const props = {
        bodies: { [bodyId]: cube() },
        requestTessellation: displayTessellation({ [bodyId]: cube() }),
        geometryPending: false,
        defaultBodyIds: [bodyId],
        editDisabledReason: null,
        onCommand: vi.fn((_command: AnyCommand) => true),
        onStatus: vi.fn()
      };
      const documentWith = (entry: DrawingSheet): ProjectDocument => ({
        ...base,
        bodyOrder: [bodyId],
        drawings: { sheets: [entry] }
      });
      const { rerender } = render(
        <DrawingWorkspace document={documentWith(sheet)} {...props} />
      );
      // Re-picking the broken dimension pins the tool to its view.
      await userEvent.click(
        screen.getByRole('option', { name: 'Horizontal dimension (broken)' })
      );
      await userEvent.click(screen.getByRole('button', { name: /Re-pick/ }));
      expect(document.querySelector('.drawing-pick-surface')).not.toBeNull();
      // Another view keeps the sheet ready; this one, and its dimension, go.
      const without: DrawingSheet = {
        ...sheet,
        views: sheet.views
          .filter((view) => view.viewId !== viewId)
          .map(({ parentViewId: _base, ...view }) => view),
        annotations: undefined
      };
      rerender(
        <DrawingWorkspace document={documentWith(without)} {...props} />
      );
      await waitFor(() =>
        expect(document.querySelector('.drawing-pick-surface')).toBeNull()
      );
    });

    it('moves and deletes the selected annotation from the keyboard, and Escape ends a tool', async () => {
      const { onCommand } = setup({ sheet: dimensioned() });
      const canvas = screen.getByRole('application', {
        name: 'Sheet Sheet 1'
      });
      fireEvent.pointerDown(
        await within(canvas).findByRole('button', {
          name: 'Horizontal dimension 10'
        }),
        { button: 0 }
      );
      fireEvent.keyDown(canvas, { key: 'ArrowUp' });
      let command = onCommand.mock.calls.at(-1)![0];
      expect(command.kind).toBe('drawing.annotation.update');
      expect(command.label).toBe('Move annotation');
      expect(
        (command.payload as { annotation: DrawingAnnotation }).annotation
          .placementMm
      ).toEqual({ x: 0, y: -14 });
      fireEvent.keyDown(canvas, { key: 'Delete' });
      command = onCommand.mock.calls.at(-1)![0];
      expect(command.kind).toBe('drawing.annotation.delete');

      await userEvent.click(screen.getByRole('button', { name: 'Vertical' }));
      expect(screen.getByRole('status').textContent).toMatch(
        /Vertical dimension: pick a straight edge/
      );
      expect(canvas.querySelector('[data-tool="vertical"]')).not.toBeNull();
      fireEvent.keyDown(canvas, { key: 'Escape' });
      expect(screen.queryByRole('status')).toBeNull();
      expect(canvas.querySelector('.drawing-pick-surface')).toBeNull();
    });
  });
});
