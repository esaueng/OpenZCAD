import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { commandFactories, type AnyCommand } from '@openzcad/command-system';
import {
  addPrimitiveFeature,
  createProjectDocument
} from '@openzcad/document-core';
import {
  formatDrawingScale,
  toUserId,
  type BodyId,
  type BodyRepresentation,
  type DrawingAnnotation,
  type DrawingAnnotationId,
  type DrawingSheet,
  type ProjectDocument
} from '@openzcad/shared';
import { DrawingWorkspace, resetRetainedProjections } from './DrawingWorkspace';
import { DrawingProjectionClient } from '../lib/drawing/projectionClient';
import {
  createStarterSheet,
  drawingSourceFingerprint,
  projectionBodyInput,
  type SectionBodyInput
} from '../lib/drawing/sheetSources';
import {
  projectView,
  type ProjectionBodyInput
} from '../lib/drawing/projectView';
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

/**
 * A 10 mm cube at the origin with outward-wound faces and its 12 edges;
 * `exact` publishes each face's plane, as the kernel does.
 */
function cube(size = 10, exact = false): BodyRepresentation {
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
        triangleCount: 2,
        ...(exact ? { geometry: CUBE_PLANES(s)[index]! } : {})
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

/** The cube's faces, in `quads` order, as exact planes. */
function CUBE_PLANES(s: number) {
  const plane = (x: number, y: number, z: number, planeOffset: number) => ({
    surfaceType: 'plane',
    area: s * s,
    center: { x: 0, y: 0, z: 0 },
    normal: { x, y, z },
    planeOffset
  });
  return [
    plane(0, 0, -1, 0),
    plane(0, 0, 1, s),
    plane(0, -1, 0, 0),
    plane(0, 1, 0, s),
    plane(1, 0, 0, s),
    plane(-1, 0, 0, 0)
  ];
}

function setup(
  options: {
    sheet?: DrawingSheet;
    size?: number;
    exactFaces?: boolean;
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
  const bodies = { [bodyId]: cube(options.size, options.exactFaces) };
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
  it('waits for ready geometry before offering a new sheet', async () => {
    const { onCommand } = setup({ geometryPending: true });
    const create = screen.getByRole('button', { name: 'New drawing sheet' });
    expect(create).toBeDisabled();
    expect(create).toHaveAttribute(
      'title',
      'Waiting for the model to finish updating.'
    );
    await userEvent.click(create);
    expect(onCommand).not.toHaveBeenCalled();
  });
  it('offers an explicit body succession Update instead of a dead-end missing-body warning', async () => {
    const base = addPrimitiveFeature(
      createProjectDocument('Plate', toUserId('test')),
      {
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 10, depth: 10 }
      }
    );
    const source = base.bodyOrder[0]!;
    const document = commandFactories
      .filletEdges({
        name: 'Fillet',
        targetBodyId: source,
        edgeHashes: [1],
        size: 1
      })
      .apply(base);
    const target = document.bodyOrder.at(-1)!;
    const bodies = {
      [source]: { ...cube(), bodyId: source, consumed: true },
      [target]: { ...cube(), bodyId: target }
    };
    const sheet = createStarterSheet({
      name: 'Sheet 1',
      bodyIds: [source],
      bodies,
      units: 'mm',
      paper: { size: 'A3', orientation: 'landscape' },
      projectionAngle: 'first',
      fingerprint: 'v1:old'
    });
    document.drawings = { sheets: [sheet] };
    const onCommand = vi.fn((_command: AnyCommand) => true);
    render(
      <DrawingWorkspace
        document={document}
        bodies={bodies}
        geometryPending={false}
        defaultBodyIds={[target]}
        requestTessellation={displayTessellation(bodies)}
        editDisabledReason={null}
        onCommand={onCommand}
        onStatus={vi.fn()}
      />
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      'Finishing features replaced a body'
    );
    expect(screen.getByRole('button', { name: 'Export PDF' })).toBeDisabled();
    expect(onCommand).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Update' }));
    expect(onCommand).toHaveBeenCalledTimes(1);
    const command = onCommand.mock.calls[0]![0];
    expect(command.kind).toBe('drawing.sheet.update');
    expect(command.payload).toMatchObject({
      sheetId: sheet.sheetId,
      bodyReplacements: [{ from: source, to: target }],
      source: { fingerprint: drawingSourceFingerprint(bodies, [target]) }
    });
  });
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
      screen.getByRole<HTMLButtonElement>('button', { name: 'Export PDF' })
        .disabled
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

  it('draws each view as soon as it is projected, before the rest of the sheet', async () => {
    const project = vi
      .spyOn(DrawingProjectionClient.prototype, 'project')
      .mockImplementationOnce((inputs, views, onView) => {
        // The first view lands; the others are still being projected.
        const first = views[0]!;
        onView?.(first.key, {
          ok: true,
          projection: projectView({
            orientation: first.orientation,
            hiddenLines: first.hiddenLines,
            bodies: first.bodyIds.map((id) => inputs[id]!)
          })
        });
        return new Promise(() => {});
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
        ).toHaveLength(3)
      );
      expect(
        canvas.querySelectorAll('.drawing-strokes.is-visible polyline').length
      ).toBeGreaterThan(0);
    } finally {
      project.mockRestore();
    }
  });

  it('keeps the projections when Draw closes and reopens on the same project', async () => {
    const project = vi.spyOn(DrawingProjectionClient.prototype, 'project');
    try {
      const fingerprint = drawingSourceFingerprint({ [bodyId]: cube() }, [
        bodyId
      ])!;
      const sheet = starter(fingerprint);
      const base = createProjectDocument('Bracket', toUserId('test'));
      const document: ProjectDocument = {
        ...base,
        bodyOrder: [bodyId],
        drawings: { sheets: [sheet] }
      };
      const requestTessellation = vi.fn(
        displayTessellation({ [bodyId]: cube() })
      );
      const workspace = (shown: ProjectDocument) => (
        <DrawingWorkspace
          document={shown}
          bodies={{ [bodyId]: cube() }}
          geometryPending={false}
          defaultBodyIds={[bodyId]}
          requestTessellation={requestTessellation}
          editDisabledReason={null}
          onCommand={vi.fn(() => true)}
          onStatus={vi.fn()}
        />
      );
      const settled = () =>
        waitFor(() =>
          expect(
            screen
              .getByRole('application', { name: 'Sheet Sheet 1' })
              .querySelectorAll('.drawing-view.is-placeholder')
          ).toHaveLength(0)
        );
      const first = render(workspace(document));
      await settled();
      expect(project).toHaveBeenCalledTimes(1);
      // Off to Build and back: every view is drawn at once, with no
      // tessellation or projection.
      first.unmount();
      const second = render(workspace(document));
      expect(
        screen
          .getByRole('application', { name: 'Sheet Sheet 1' })
          .querySelectorAll('.drawing-view.is-placeholder')
      ).toHaveLength(0);
      expect(project).toHaveBeenCalledTimes(1);
      expect(requestTessellation).toHaveBeenCalledTimes(1);
      second.unmount();
      // Another project keeps nothing of this one's.
      const other = createProjectDocument('Other', toUserId('test'));
      render(
        workspace({
          ...other,
          bodyOrder: [bodyId],
          drawings: { sheets: [sheet] }
        })
      );
      await settled();
      expect(project).toHaveBeenCalledTimes(2);
    } finally {
      project.mockRestore();
    }
  });

  it('asks again for views whose projection was cut off when Draw closed', async () => {
    const original = DrawingProjectionClient.prototype.project;
    const project = vi
      .spyOn(DrawingProjectionClient.prototype, 'project')
      // The first workspace closes while its views are still projecting.
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockImplementation(function (this: DrawingProjectionClient, ...args) {
        return original.apply(this, args);
      });
    try {
      const fingerprint = drawingSourceFingerprint({ [bodyId]: cube() }, [
        bodyId
      ])!;
      const base = createProjectDocument('Bracket', toUserId('test'));
      const document: ProjectDocument = {
        ...base,
        bodyOrder: [bodyId],
        drawings: { sheets: [starter(fingerprint)] }
      };
      const workspace = () => (
        <DrawingWorkspace
          document={document}
          bodies={{ [bodyId]: cube() }}
          geometryPending={false}
          defaultBodyIds={[bodyId]}
          requestTessellation={displayTessellation({ [bodyId]: cube() })}
          editDisabledReason={null}
          onCommand={vi.fn(() => true)}
          onStatus={vi.fn()}
        />
      );
      const first = render(workspace());
      await waitFor(() => expect(project).toHaveBeenCalledTimes(1));
      first.unmount();
      render(workspace());
      await waitFor(() =>
        expect(
          screen
            .getByRole('application', { name: 'Sheet Sheet 1' })
            .querySelectorAll('.drawing-view.is-placeholder')
        ).toHaveLength(0)
      );
      expect(project).toHaveBeenCalledTimes(2);
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
      screen.getByRole<HTMLButtonElement>('button', { name: 'Export PDF' })
        .disabled
    ).toBe(true);
  });

  it('keeps the last drawing, faded and unexportable, while the model rebuilds', async () => {
    const bodies = { [bodyId]: cube() };
    const fingerprint = drawingSourceFingerprint(bodies, [bodyId])!;
    const document: ProjectDocument = {
      ...createProjectDocument('Bracket', toUserId('test')),
      bodyOrder: [bodyId],
      drawings: { sheets: [starter(fingerprint)] }
    };
    const workspace = (pending: boolean) => (
      <DrawingWorkspace
        document={document}
        bodies={bodies}
        geometryPending={pending}
        rebuildProgress={pending ? { name: 'Gear', index: 5, total: 10 } : null}
        defaultBodyIds={[bodyId]}
        requestTessellation={displayTessellation(bodies)}
        editDisabledReason={null}
        onCommand={vi.fn(() => true)}
        onStatus={vi.fn()}
      />
    );
    const { rerender } = render(workspace(false));
    const canvas = screen.getByRole('application', { name: 'Sheet Sheet 1' });
    await waitFor(() =>
      expect(
        canvas.querySelectorAll('.drawing-view.is-placeholder')
      ).toHaveLength(0)
    );
    rerender(workspace(true));
    // The last drawing stays on the paper instead of empty outlines…
    expect(canvas.classList.contains('is-ghost')).toBe(true);
    expect(
      canvas.querySelectorAll('.drawing-strokes.is-visible polyline').length
    ).toBeGreaterThan(0);
    expect(canvas.querySelectorAll('.drawing-view-outline')).toHaveLength(0);
    // …but it is not the model the document holds: nothing reads ready.
    expect(
      canvas.querySelectorAll('.drawing-view.is-placeholder')
    ).toHaveLength(4);
    expect(screen.getByRole('status')).toHaveTextContent(
      'Rebuilding Gear (5 of 10). Showing the last drawing'
    );
    expect(
      screen.getByRole('progressbar', { name: 'Model rebuild' })
    ).toHaveAttribute('aria-valuenow', '5');
    expect(screen.getByRole('button', { name: 'Export PDF' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Horizontal' })).toBeDisabled();
  });

  it('picks tools by key and backs out with Escape, but never from a field', async () => {
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
    const horizontal = screen.getByRole('button', { name: 'Horizontal' });
    const reached = vi.fn();
    window.addEventListener('keydown', reached);
    try {
      await userEvent.keyboard('h');
      expect(horizontal).toHaveAttribute('aria-pressed', 'true');
      // Taken before the workspace's modeling shortcuts see it.
      expect(reached).not.toHaveBeenCalled();
      await userEvent.keyboard('{Escape}');
      expect(horizontal).toHaveAttribute('aria-pressed', 'false');
      expect(screen.getByRole('button', { name: 'Select' })).toHaveAttribute(
        'aria-pressed',
        'true'
      );
      await userEvent.click(screen.getByRole('button', { name: 'Front view' }));
      expect(screen.getByLabelText('Centre X (mm)')).toBeInTheDocument();
      await userEvent.keyboard('{Escape}');
      expect(screen.queryByLabelText('Centre X (mm)')).toBeNull();
      await userEvent.type(screen.getByLabelText('Name'), 'h');
      expect(horizontal).toHaveAttribute('aria-pressed', 'false');
    } finally {
      window.removeEventListener('keydown', reached);
    }
  });

  it('shows the paper dark on request and remembers it on this device', async () => {
    window.localStorage.removeItem('openzcad.drawing.darkPaper');
    const fingerprint = drawingSourceFingerprint({ [bodyId]: cube() }, [
      bodyId
    ])!;
    setup({ sheet: starter(fingerprint) });
    const workspace = screen.getByRole('region', { name: 'Drawings' });
    expect(workspace.classList.contains('is-dark-paper')).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: 'Dark paper' }));
    expect(workspace.classList.contains('is-dark-paper')).toBe(true);
    expect(window.localStorage.getItem('openzcad.drawing.darkPaper')).toBe('1');
    await userEvent.click(screen.getByRole('button', { name: 'Dark paper' }));
    expect(workspace.classList.contains('is-dark-paper')).toBe(false);
    expect(window.localStorage.getItem('openzcad.drawing.darkPaper')).toBe('0');
  });

  it('shows a stale sheet it never drew as outlines, refuses export and rebinds on Update', async () => {
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
      screen.getByRole<HTMLButtonElement>('button', { name: 'Export PDF' })
        .disabled
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
      const tabs = screen.getByRole('tablist', { name: 'Drawing sheets' });
      await settled('Sheet 1');
      await userEvent.click(within(tabs).getByRole('tab', { name: 'Sheet 2' }));
      await settled('Sheet 2');
      await userEvent.click(within(tabs).getByRole('tab', { name: 'Sheet 1' }));
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
    // The ISO enlargements and common intermediates, largest first.
    expect(options).toEqual(
      expect.arrayContaining(['50:1', '20:1', '4:1', '1:4', '1:25', '1:250'])
    );
    expect(options.slice(0, 3)).toEqual(['50:1', '20:1', '10:1']);
  });

  it('auto scales a hand-shrunk sheet back up in one undoable command', async () => {
    const fitted = starter(
      drawingSourceFingerprint({ [bodyId]: cube() }, [bodyId])!
    );
    const sheet: DrawingSheet = {
      ...fitted,
      scale: { numerator: 1, denominator: 2 }
    };
    const { onCommand, onStatus } = setup({ sheet });
    const canvas = screen.getByRole('application', { name: 'Sheet Sheet 1' });
    await waitFor(() =>
      expect(
        canvas.querySelectorAll('.drawing-view.is-placeholder')
      ).toHaveLength(0)
    );
    await userEvent.click(screen.getByRole('button', { name: 'Auto scale' }));
    expect(onCommand).toHaveBeenCalledTimes(1);
    const command = onCommand.mock.calls[0]![0];
    expect(command.label).toBe('Auto scale');
    const before: ProjectDocument = {
      ...createProjectDocument('Bracket', toUserId('test')),
      bodyOrder: [bodyId],
      drawings: { sheets: [sheet] }
    };
    command.validate(before);
    const after = command.apply(before);
    expect(after.drawings!.sheets[0]!.scale).toEqual(fitted.scale);
    expect(onStatus).toHaveBeenLastCalledWith(
      `Scaled the views to ${formatDrawingScale(fitted.scale)}, the largest scale that fits the sheet.`
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

    it('keeps the earlier drawing usable after a model change until Update', async () => {
      const doc: ProjectDocument = {
        ...createProjectDocument('Bracket', toUserId('test')),
        bodyOrder: [bodyId],
        drawings: { sheets: [dimensioned()] }
      };
      const onCommand = vi.fn((_command: AnyCommand) => true);
      const workspace = (size: number, shown = doc) => {
        const bodies = { [bodyId]: cube(size) };
        return (
          <DrawingWorkspace
            document={shown}
            bodies={bodies}
            geometryPending={false}
            defaultBodyIds={[bodyId]}
            requestTessellation={displayTessellation(bodies)}
            editDisabledReason={null}
            onCommand={onCommand}
            onStatus={vi.fn()}
          />
        );
      };
      const first = render(workspace(10));
      const drawn = screen.getByRole('application', { name: 'Sheet Sheet 1' });
      await within(drawn).findByRole('button', {
        name: 'Horizontal dimension 10'
      });
      await waitFor(() =>
        expect(
          drawn.querySelectorAll('.drawing-view.is-placeholder')
        ).toHaveLength(0)
      );
      // Leave Draw, change the model in Build, come back.
      first.unmount();
      const { rerender } = render(workspace(12));
      const canvas = screen.getByRole('application', { name: 'Sheet Sheet 1' });
      // The sheet is drawn as it was, not faded or reduced to outlines…
      expect(canvas.classList.contains('is-ghost')).toBe(false);
      expect(
        canvas.querySelectorAll('.drawing-view.is-placeholder')
      ).toHaveLength(0);
      expect(
        canvas.querySelectorAll('.drawing-strokes.is-visible polyline').length
      ).toBeGreaterThan(0);
      // …its dimensions still read the model it was drawn from (the new
      // cube has no edge with that hash at all)…
      expect(
        within(canvas).getByRole('button', { name: 'Horizontal dimension 10' })
      ).toBeTruthy();
      // …and it exports and annotates as before.
      expect(
        screen.getByRole('button', { name: 'Export PDF' })
      ).not.toBeDisabled();
      expect(
        screen.getByRole('button', { name: 'Horizontal' })
      ).not.toBeDisabled();
      // One quiet pill offers the Update; nothing forces it.
      expect(screen.getByRole('status')).toHaveTextContent('Model changed');
      expect(document.querySelector('.drawing-banner')).toBeNull();
      expect(onCommand).not.toHaveBeenCalled();
      await userEvent.click(screen.getByRole('button', { name: /Update/ }));
      const command = onCommand.mock.calls[0]![0];
      expect(command.kind).toBe('drawing.sheet.update');
      expect(command.payload).toMatchObject({
        source: {
          fingerprint: drawingSourceFingerprint({ [bodyId]: cube(12) }, [
            bodyId
          ])
        }
      });
      // The Update lands and the sheet redraws from the new model…
      const updated: ProjectDocument = {
        ...doc,
        drawings: {
          sheets: [
            {
              ...doc.drawings!.sheets[0]!,
              source: {
                fingerprint: drawingSourceFingerprint({ [bodyId]: cube(12) }, [
                  bodyId
                ])!
              }
            }
          ]
        }
      };
      rerender(workspace(12, updated));
      await waitFor(() =>
        expect(document.querySelector('.drawing-sync.is-outdated')).toBeNull()
      );
      await waitFor(() =>
        expect(
          canvas.querySelectorAll('.drawing-view.is-placeholder')
        ).toHaveLength(0)
      );
      // …and undoing it brings the earlier drawing back, not outlines.
      rerender(workspace(12));
      expect(
        document.querySelector('.drawing-sync.is-outdated')
      ).toHaveTextContent('Model changed');
      expect(
        canvas.querySelectorAll('.drawing-view.is-placeholder')
      ).toHaveLength(0);
      expect(
        within(canvas).getByRole('button', { name: 'Horizontal dimension 10' })
      ).toBeTruthy();
    });

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
        screen.getByRole<HTMLButtonElement>('button', { name: 'Export PDF' })
          .disabled
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
        screen.getByRole<HTMLButtonElement>('button', { name: 'Export PDF' })
          .disabled
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

describe('DrawingWorkspace QA fixes', () => {
  const fingerprint = () =>
    drawingSourceFingerprint({ [bodyId]: cube() }, [bodyId])!;
  const withSheets = (sheets: DrawingSheet[]): ProjectDocument => ({
    ...createProjectDocument('Bracket', toUserId('test')),
    bodyOrder: [bodyId],
    drawings: { sheets }
  });
  const viewBox = () =>
    screen
      .getByRole('application', { name: 'Sheet Sheet 1' })
      .getAttribute('viewBox')!
      .split(' ')
      .map(Number) as [number, number, number, number];

  it('flags a view partly off the paper, refuses export, and fits the views back', async () => {
    // QA F006: the old flag tested only the centre, so a view half off the
    // paper exported half a view without a word.
    const sheet = starter(fingerprint());
    const iso = sheet.views.find((view) => view.orientation === 'iso')!;
    // A3 landscape is 420 mm wide: the centre stays on it, the view does not.
    iso.centerMm = { x: 416, y: iso.centerMm.y };
    const onCommand = vi.fn((_command: AnyCommand) => true);
    const shared = {
      bodies: { [bodyId]: cube() },
      geometryPending: false,
      defaultBodyIds: [bodyId],
      requestTessellation: displayTessellation({ [bodyId]: cube() }),
      editDisabledReason: null,
      onCommand,
      onStatus: vi.fn()
    };
    const before = withSheets([sheet]);
    const { rerender } = render(
      <DrawingWorkspace document={before} {...shared} />
    );
    const canvas = screen.getByRole('application', { name: 'Sheet Sheet 1' });
    await waitFor(() =>
      expect(
        canvas.querySelectorAll('.drawing-view.is-placeholder')
      ).toHaveLength(0)
    );
    const list = screen.getByRole('listbox', { name: 'Views on this sheet' });
    expect(
      within(list).getByRole('option', {
        name: 'Isometric (partly off the page)'
      })
    ).toBeTruthy();
    const pdf = screen.getByRole<HTMLButtonElement>('button', {
      name: 'Export PDF'
    });
    expect(pdf.disabled).toBe(true);
    expect(pdf.title).toBe(
      'The Isometric view runs off the paper. Fit views to sheet, or move it onto the page, to export.'
    );
    expect(screen.getByRole('status').textContent).toBe(pdf.title);

    await userEvent.click(
      screen.getByRole('button', { name: 'Fit views to sheet' })
    );
    // One command, so one undo puts the layout back.
    expect(onCommand).toHaveBeenCalledTimes(1);
    const command = onCommand.mock.calls[0]![0];
    expect(command.label).toBe('Fit views to sheet');
    expect(
      command.commands?.every((entry) => entry.kind.startsWith('drawing.'))
    ).toBe(true);
    command.validate(before);
    const after = command.apply(before);
    rerender(<DrawingWorkspace document={after} {...shared} />);
    await waitFor(() =>
      expect(
        screen.getByRole<HTMLButtonElement>('button', { name: 'Export PDF' })
          .disabled
      ).toBe(false)
    );
    expect(
      within(
        screen.getByRole('listbox', { name: 'Views on this sheet' })
      ).getByRole('option', { name: 'Isometric' })
    ).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('warns, without refusing, about sheet text the PDF font prints as "?"', () => {
    // QA F008: U+2300 prints as Ø; a star has no stand-in and becomes "?".
    setup({ sheet: starter(fingerprint()) });
    const title = screen.getByRole('textbox', { name: 'Title' });
    fireEvent.change(title, { target: { value: '⌀12 bore' } });
    expect(screen.queryByRole('status')).toBeNull();
    fireEvent.change(title, { target: { value: '⌀12 bore ★' } });
    const warning = screen.getByRole('status');
    expect(warning.textContent).toContain('★ will print as "?"');
    expect(warning.textContent).not.toContain('⌀');
  });

  describe('sheet zoom', () => {
    // A3 landscape (420 × 297 mm) fitted to an 840 × 594 px canvas: 2 px/mm.
    const mockCanvas = () =>
      vi
        .spyOn(Element.prototype, 'getBoundingClientRect')
        .mockReturnValue(new DOMRect(0, 0, 840, 594));

    it('zooms with the buttons, shows the level and fits the sheet again', async () => {
      setup({ sheet: starter(fingerprint()) });
      const zoom = screen.getByRole('toolbar', { name: 'Sheet zoom' });
      const button = (name: string) =>
        within(zoom).getByRole<HTMLButtonElement>('button', { name });
      expect(zoom.textContent).toContain('100%');
      expect(viewBox()).toEqual([0, 0, 420, 297]);
      await userEvent.click(button('Zoom in'));
      expect(zoom.textContent).toContain('125%');
      // About the sheet's centre: 420 / 1.25 = 336 mm wide.
      expect(viewBox()).toEqual([42, 29.7, 336, 237.6]);
      await userEvent.click(button('Zoom out'));
      expect(zoom.textContent).toContain('100%');
      await userEvent.click(button('Zoom in'));
      await userEvent.click(button('Fit sheet'));
      expect(viewBox()).toEqual([0, 0, 420, 297]);
      expect(button('Fit sheet').disabled).toBe(true);
    });

    it('zooms about the pointer with Ctrl+wheel, and scrolls only once zoomed', () => {
      const rect = mockCanvas();
      try {
        setup({ sheet: starter(fingerprint()) });
        const canvas = screen.getByRole('application', {
          name: 'Sheet Sheet 1'
        });
        // happy-dom's WheelEvent has no modifier keys or pointer position
        // (it extends UIEvent), so they are set on the event as a browser
        // would deliver them. Returns whether the default went ahead.
        const wheel = (
          init: { deltaY: number; ctrlKey?: boolean },
          at = { x: 0, y: 0 }
        ) => {
          const event = new WheelEvent('wheel', {
            deltaY: init.deltaY,
            bubbles: true,
            cancelable: true
          });
          for (const [key, value] of Object.entries({
            ctrlKey: init.ctrlKey ?? false,
            metaKey: false,
            shiftKey: false,
            clientX: at.x,
            clientY: at.y
          }))
            Object.defineProperty(event, key, { value });
          let result = true;
          act(() => {
            result = canvas.dispatchEvent(event);
          });
          return result;
        };
        // A plain wheel on a fitted sheet is left to the page.
        expect(wheel({ deltaY: 100 })).toBe(true);
        expect(viewBox()).toEqual([0, 0, 420, 297]);
        // The pointer at (210, 150) px is over paper (105, 75) mm (SVG y
        // down); zooming in keeps that point under it.
        expect(wheel({ deltaY: -300, ctrlKey: true }, { x: 210, y: 150 })).toBe(
          false
        );
        const [x0, y0, width, height] = viewBox();
        const zoom = 420 / width;
        expect(zoom).toBeGreaterThan(1.5);
        expect(height).toBeCloseTo(297 / zoom, 2);
        const pxPerMm = 2 * zoom;
        expect(x0 + width / 2 + (210 - 420) / pxPerMm).toBeCloseTo(105, 1);
        expect(y0 + height / 2 + (150 - 297) / pxPerMm).toBeCloseTo(75, 1);
        // Zoomed, a plain wheel scrolls the sheet.
        expect(wheel({ deltaY: 80 })).toBe(false);
        expect(viewBox()[1]).toBeCloseTo(y0 + 80 / pxPerMm, 2);
        expect(viewBox()[0]).toBeCloseTo(x0, 2);
      } finally {
        rect.mockRestore();
      }
    });

    it('pans by dragging empty paper and keeps view drags in paper millimetres', async () => {
      const rect = mockCanvas();
      try {
        const { onCommand } = setup({ sheet: starter(fingerprint()) });
        const canvas = screen.getByRole('application', {
          name: 'Sheet Sheet 1'
        });
        const zoomIn = screen.getByRole('button', { name: 'Zoom in' });
        await userEvent.click(zoomIn);
        await userEvent.click(zoomIn);
        // 1.25² zoom: 2 × 1.5625 = 3.125 px per paper millimetre.
        const [x0, y0] = viewBox();
        fireEvent.pointerDown(canvas, {
          button: 0,
          pointerId: 7,
          clientX: 400,
          clientY: 300
        });
        fireEvent.pointerMove(canvas, {
          pointerId: 7,
          clientX: 431.25,
          clientY: 300
        });
        fireEvent.pointerUp(canvas, { pointerId: 7 });
        expect(viewBox()[0]).toBeCloseTo(x0 - 10, 3);
        expect(viewBox()[1]).toBeCloseTo(y0, 3);
        expect(onCommand).not.toHaveBeenCalled();

        // Dragging a view 62.5 px at this zoom moves it 20 mm, not 31.25.
        const iso = screen.getByRole('button', { name: 'Isometric view' });
        const origin = starter(fingerprint()).views.find(
          (view) => view.orientation === 'iso'
        )!.centerMm;
        fireEvent.pointerDown(iso, { button: 0, clientX: 100, clientY: 100 });
        fireEvent.pointerMove(iso, { clientX: 162.5, clientY: 100 });
        fireEvent.pointerUp(iso);
        const command = onCommand.mock.calls.at(-1)![0];
        expect(command.kind).toBe('drawing.view.update');
        expect(
          (command.payload as { centerMm: { x: number } }).centerMm.x
        ).toBeCloseTo(Math.round((origin.x + 20) * 10) / 10, 5);
      } finally {
        rect.mockRestore();
      }
    });
  });
});

describe('DrawingWorkspace section views (D03)', () => {
  /** The cube's x ≤ 5 half, as the geometry worker cuts it for a −X view. */
  function halfCube(): SectionBodyInput {
    const half = cube();
    const vertices = Float32Array.from(half.mesh.vertices, (value, index) =>
      index % 3 === 0 ? Math.min(value, 5) : value
    );
    const input = projectionBodyInput({
      ...half,
      mesh: { ...half.mesh, vertices }
    })!;
    return {
      ...input,
      // The +X quad, now at x = 5, is the cut face.
      cutFaces: [4],
      edgeTopology: half.topology!.edges.map((edge) => ({
        ...edge,
        points: edge.points.map((value, index) =>
          index % 3 === 0 ? Math.min(value, 5) : value
        )
      }))
    };
  }

  function withSection(fingerprint: string): DrawingSheet {
    const sheet = starter(fingerprint);
    const front = sheet.views.find((view) => view.orientation === 'front')!;
    return {
      ...sheet,
      views: [
        front,
        {
          viewId: 'dvw_section' as DrawingSheet['views'][number]['viewId'],
          orientation: 'right',
          bodyIds: [bodyId],
          // First angle: the right view sits left of the front.
          centerMm: { x: front.centerMm.x - 60, y: front.centerMm.y },
          hiddenLines: false,
          section: { sourceViewId: front.viewId, label: 'A', depth: -5 }
        }
      ]
    };
  }

  function renderSheet(
    sheet: DrawingSheet,
    requestSection: NonNullable<
      Parameters<typeof DrawingWorkspace>[0]['requestSection']
    >
  ) {
    const base = createProjectDocument('Bracket', toUserId('test'));
    const bodies = { [bodyId]: cube() };
    const onCommand = vi.fn((_command: AnyCommand) => true);
    const onStatus = vi.fn();
    render(
      <DrawingWorkspace
        document={{
          ...base,
          bodyOrder: [bodyId],
          drawings: { sheets: [sheet] }
        }}
        bodies={bodies}
        geometryPending={false}
        defaultBodyIds={[bodyId]}
        requestTessellation={displayTessellation(bodies)}
        requestSection={requestSection}
        editDisabledReason={null}
        onCommand={onCommand}
        onStatus={onStatus}
      />
    );
    return { onCommand, onStatus };
  }

  it('draws a section hatched, with its cutting-plane line and caption', async () => {
    resetRetainedProjections();
    const fingerprint = drawingSourceFingerprint({ [bodyId]: cube() }, [
      bodyId
    ])!;
    const requestSection = vi.fn(
      (_document: ProjectDocument, _bodyIds: BodyId[], _plane: unknown) =>
        Promise.resolve({ [bodyId]: halfCube() })
    );
    renderSheet(withSection(fingerprint), requestSection);
    const canvas = screen.getByRole('application', { name: 'Sheet Sheet 1' });
    await waitFor(() =>
      expect(
        canvas.querySelectorAll('.drawing-strokes.is-hatch polyline').length
      ).toBeGreaterThan(0)
    );
    expect(requestSection).toHaveBeenCalledTimes(1);
    expect(requestSection.mock.calls[0]![2]).toEqual({
      normal: { x: -1, y: 0, z: 0 },
      depth: -5
    });
    expect(
      canvas.querySelectorAll('.drawing-strokes.is-chain polyline')
    ).toHaveLength(1);
    expect(
      canvas.querySelectorAll('.drawing-strokes.is-cutting polyline')
    ).toHaveLength(2);
    expect(within(canvas).getByText('SECTION A-A')).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Section A-A' })).toBeTruthy();
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Export PDF' })
        .disabled
    ).toBe(false);
  });

  it('shows a refused section on its view and refuses export, without retrying', async () => {
    resetRetainedProjections();
    const fingerprint = drawingSourceFingerprint({ [bodyId]: cube() }, [
      bodyId
    ])!;
    const requestSection = vi.fn(() =>
      Promise.reject(
        new Error('The section line does not cut any body in this view.')
      )
    );
    renderSheet(withSection(fingerprint), requestSection);
    await waitFor(() =>
      expect(
        screen.getAllByText(/Section A-A cannot be drawn/).length
      ).toBeGreaterThan(0)
    );
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Export PDF' })
        .disabled
    ).toBe(true);
    expect(requestSection).toHaveBeenCalledTimes(1);
  });

  it('creates a section from a line dragged across a view, placed by a click', async () => {
    resetRetainedProjections();
    const fingerprint = drawingSourceFingerprint({ [bodyId]: cube() }, [
      bodyId
    ])!;
    const sheet = starter(fingerprint);
    const { onCommand } = renderSheet(sheet, () =>
      Promise.resolve({ [bodyId]: halfCube() })
    );
    const canvas = screen.getByRole('application', { name: 'Sheet Sheet 1' });
    await waitFor(() =>
      expect(
        canvas.querySelectorAll('.drawing-view.is-placeholder')
      ).toHaveLength(0)
    );
    fireEvent.click(screen.getByRole('button', { name: 'Section view' }));
    const surface = canvas.querySelector('.drawing-section-surface')!;
    expect(surface).toBeTruthy();
    // happy-dom has no screen matrix: drive the tool in paper millimetres
    // through a CTM that maps client pixels to them one to one.
    const paperHeight = 297;
    Object.defineProperty(canvas, 'getScreenCTM', {
      configurable: true,
      value: () => ({
        a: 1,
        b: 0,
        c: 0,
        d: 1,
        e: 0,
        f: 0,
        inverse: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 })
      })
    });
    const front = sheet.views.find((view) => view.orientation === 'front')!;
    const client = (x: number, y: number) => ({
      clientX: x,
      clientY: paperHeight - y,
      button: 0,
      pointerId: 1
    });
    // Down the front view's middle, top to bottom: a vertical line at x = 5,
    // starting a little off it so the snap to the middle has work to do.
    const x = front.centerMm.x + 0.8;
    fireEvent.pointerDown(surface, client(x, front.centerMm.y + 8));
    fireEvent.pointerMove(surface, client(x, front.centerMm.y - 8));
    fireEvent.pointerUp(surface, client(x, front.centerMm.y - 8));
    // Placed to the left: in first angle that is the right view.
    fireEvent.pointerMove(
      surface,
      client(front.centerMm.x - 50, front.centerMm.y)
    );
    expect(canvas.querySelector('.drawing-section-ghost')).toBeTruthy();
    fireEvent.pointerDown(
      surface,
      client(front.centerMm.x - 50, front.centerMm.y)
    );
    const added = onCommand.mock.calls
      .map(([command]) => command)
      .find((command) => command.kind === 'drawing.view.add');
    expect(added).toBeTruthy();
    const view = (added!.payload as { view: DrawingSheet['views'][number] })
      .view;
    expect(view.orientation).toBe('right');
    // The plane x = 5 seen along −X: depth −5, snapped to the middle.
    expect(view.section).toEqual({
      sourceViewId: front.viewId,
      label: 'A',
      depth: -5
    });
    expect(view.centerMm.y).toBe(front.centerMm.y);
  });
});

describe('DrawingWorkspace dimension check (D06)', () => {
  const exactCube = () => cube(10, true);
  const sheetWith = (annotations: DrawingAnnotation[]) => {
    const sheet = createStarterSheet({
      name: 'Sheet 1',
      bodyIds: [bodyId],
      bodies: { [bodyId]: exactCube() },
      units: 'mm',
      paper: { size: 'A3', orientation: 'landscape' },
      projectionAngle: 'first',
      fingerprint: drawingSourceFingerprint({ [bodyId]: exactCube() }, [
        bodyId
      ])!
    });
    const front = sheet.views.find((view) => view.orientation === 'front')!;
    return {
      ...sheet,
      annotations: annotations.map((annotation) => ({
        ...annotation,
        viewId: front.viewId
      })) as DrawingAnnotation[]
    };
  };
  // The cube's front bottom edge, (0,0,0)–(10,0,0).
  const width = (name: string): DrawingAnnotation => ({
    annotationId: `dann_${name}` as DrawingAnnotationId,
    kind: 'linear',
    viewId: 'unset' as never,
    direction: 'horizontal',
    from: { edge: { bodyId, hash: 210 }, anchor: 'first' },
    to: { edge: { bodyId, hash: 210 }, anchor: 'second' },
    placementMm: { x: 0, y: -20 }
  });

  it('lists what the sheet still needs once it matches the model', async () => {
    setup({ sheet: sheetWith([]), exactFaces: true });
    const missing = await screen.findByRole('list', {
      name: 'Missing dimensions'
    });
    expect(
      within(missing)
        .getAllByRole('listitem')
        .map((item) => item.textContent)
    ).toEqual([
      'X: nothing locates the face at x = 10 from the face at x = 0.',
      'Y: nothing locates the face at y = 10 from the face at y = 0.',
      'Z: nothing locates the face at z = 10 from the face at z = 0.'
    ]);
    expect(screen.getByText('0 of 3 stated')).toBeTruthy();
  });

  it('selects a repeated dimension from the check', async () => {
    setup({
      sheet: sheetWith([width('first'), width('again')]),
      exactFaces: true
    });
    const repeated = await screen.findByRole('button', {
      name: /Another dimension already states this distance/
    });
    await userEvent.click(repeated);
    expect(
      screen
        .getByRole('listbox', { name: 'Annotations on this sheet' })
        .querySelector('[aria-selected="true"]')?.textContent
    ).toBe('Horizontal dimension 10');
    expect(screen.getByText('1 of 3 stated')).toBeTruthy();
  });

  it('previews Auto-dimension on the sheet, then adds it as one command', async () => {
    const { onCommand, onStatus } = setup({
      sheet: sheetWith([]),
      exactFaces: true
    });
    const auto = await screen.findByRole('button', { name: 'Auto-dimension' });
    await waitFor(() => expect(auto).toBeEnabled());
    await userEvent.click(auto);
    const preview = screen.getByRole('group', {
      name: 'Auto-dimension preview'
    });
    expect(
      within(preview).getByText('Adds 3 dimensions, shown on the sheet.')
    ).toBeTruthy();
    // Drawn on the sheet, but nothing changes before Apply.
    const drawn = screen.getByRole('img', { name: 'Auto-dimension preview' });
    expect(
      [...drawn.querySelectorAll('text')].map((text) => text.textContent)
    ).toEqual(['10', '10', '10']);
    expect(onCommand).not.toHaveBeenCalled();

    await userEvent.click(
      within(preview).getByRole('button', { name: 'Apply' })
    );
    expect(onCommand).toHaveBeenCalledTimes(1);
    const command = onCommand.mock.calls[0]![0];
    expect(command.kind).toBe('transaction');
    expect(command.label).toBe('Auto-dimension');
    expect(command.commands?.map((entry) => entry.kind)).toEqual([
      'drawing.annotation.add',
      'drawing.annotation.add',
      'drawing.annotation.add'
    ]);
    expect(onStatus).toHaveBeenCalledWith('Added 3 dimensions.');
    expect(
      screen.queryByRole('group', { name: 'Auto-dimension preview' })
    ).toBeNull();
  });

  it('cancels the Auto-dimension preview on Escape, changing nothing', async () => {
    const { onCommand } = setup({ sheet: sheetWith([]), exactFaces: true });
    const auto = await screen.findByRole('button', { name: 'Auto-dimension' });
    await waitFor(() => expect(auto).toBeEnabled());
    await userEvent.click(auto);
    expect(
      screen.getByRole('group', { name: 'Auto-dimension preview' })
    ).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    expect(
      screen.queryByRole('group', { name: 'Auto-dimension preview' })
    ).toBeNull();
    expect(
      screen.queryByRole('img', { name: 'Auto-dimension preview' })
    ).toBeNull();
    expect(onCommand).not.toHaveBeenCalled();
  });

  it('offers Auto-dimension only while the sheet can be edited', async () => {
    setup({
      sheet: sheetWith([]),
      exactFaces: true,
      editDisabledReason: 'Viewers cannot edit drawings.'
    });
    const auto = await screen.findByRole('button', { name: 'Auto-dimension' });
    expect(auto).toBeDisabled();
    expect(auto).toHaveAttribute('title', 'Viewers cannot edit drawings.');
  });
});
