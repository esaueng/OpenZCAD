import {
  cleanup,
  render,
  screen,
  waitFor,
  within
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addConfigurationRow,
  createConfigurations,
  createProjectDocument
} from '@openzcad/document-core';
import {
  toUserId,
  type BodyId,
  type BodyRepresentation,
  type DrawingAnnotation,
  type DrawingAnnotationId,
  type DrawingLinearDimension,
  type DrawingSheet,
  type DrawingView,
  type DrawingViewId,
  type ProjectDocument
} from '@openzcad/shared';
import { DrawingWorkspace, resetRetainedProjections } from './DrawingWorkspace';
import {
  createStarterSheet,
  drawingSourceFingerprint,
  projectionBodyInput
} from '../lib/drawing/sheetSources';
import type { ProjectionBodyInput } from '../lib/drawing/projectView';
import type * as DesktopBridge from '../lib/desktopBridge';

/**
 * F06 (#2111, #2113, #2235, #2236): a drawing view pinned to a configuration
 * row measures, dimensions and exports that row's geometry, never the
 * active row's, whichever row the model is on and whether or not the sheet
 * is up to date.
 */

const saved = vi.hoisted(() => [] as { name: string; text: string }[]);
vi.mock('../lib/desktopBridge', async (importOriginal) => {
  const actual = await importOriginal<typeof DesktopBridge>();
  return {
    ...actual,
    saveCadTextFile: vi.fn((name: string, _format: string, text: string) => {
      saved.push({ name, text });
      return Promise.resolve(true);
    })
  };
});

const bodyId = 'body_plate' as BodyId;
const WIDE = 'row_wide';
const NARROW = 'row_narrow';
/** A row that suppresses the plate. */
const BARE = 'row_bare';

/**
 * A `width` × 28 × 7 mm plate at the origin. Its faces and edges keep their
 * hashes whatever its width, as a configuration's do.
 */
function plate(width: number): BodyRepresentation {
  const [w, d, h] = [width, 28, 7];
  const corners = [
    [0, 0, 0],
    [w, 0, 0],
    [w, d, 0],
    [0, d, 0],
    [0, 0, h],
    [w, 0, h],
    [w, d, h],
    [0, d, h]
  ];
  const quads = [
    [0, 3, 2, 1],
    [4, 5, 6, 7],
    [0, 1, 5, 4],
    [2, 3, 7, 6],
    [1, 2, 6, 5],
    [0, 4, 7, 3]
  ];
  const pairs = [
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
    name: 'Plate',
    source: 'primitive',
    mesh: {
      kind: 'mesh',
      vertices: Float32Array.from(corners.flat()),
      indices: Uint32Array.from(
        quads.flatMap(([a, b, c, e]) => [a!, b!, c!, a!, c!, e!])
      )
    },
    faceCount: 6,
    color: '#888888',
    exportableStep: true,
    consumed: false,
    volume: w * d * h,
    bbox: { min: { x: 0, y: 0, z: 0 }, max: { x: w, y: d, z: h } },
    topology: {
      // Exact planes, as the kernel publishes them: `quads` order.
      faces: (
        [
          [0, 0, -1, 0, w * d],
          [0, 0, 1, h, w * d],
          [0, -1, 0, 0, w * h],
          [0, 1, 0, d, w * h],
          [1, 0, 0, w, d * h],
          [-1, 0, 0, 0, d * h]
        ] as const
      ).map(([x, y, z, planeOffset, area], index) => ({
        topologyId: `f${index}`,
        hash: 100 + index,
        triangleStart: index * 2,
        triangleCount: 2,
        geometry: {
          surfaceType: 'plane',
          area,
          center: { x: 0, y: 0, z: 0 },
          normal: { x, y, z },
          planeOffset
        }
      })),
      edges: pairs.map(([a, b], index) => ({
        topologyId: `e${index}`,
        hash: 200 + index,
        points: [...corners[a!]!, ...corners[b!]!]
      }))
    }
  };
}

const WIDTHS: Record<string, number> = { [WIDE]: 70, [NARROW]: 40 };

/** What a row builds: the plate at that row's width, or nothing. */
function rowBodies(
  document: ProjectDocument
): Record<string, BodyRepresentation> {
  const width = WIDTHS[document.configurations!.activeRowId];
  return width ? { [bodyId]: plate(width) } : {};
}

function tessellate(
  document: ProjectDocument,
  bodyIds: BodyId[]
): Promise<Record<string, ProjectionBodyInput>> {
  const bodies = rowBodies(document);
  return Promise.resolve(
    Object.fromEntries(
      bodyIds.flatMap((id) => {
        const input = bodies[id] ? projectionBodyInput(bodies[id]) : null;
        return input ? [[id, input]] : [];
      })
    )
  );
}

/** Wide and Narrow rows; the same project whichever row is active. */
const project = (() => {
  let document = createConfigurations(
    createProjectDocument('Bracket', toUserId('test')),
    { rowId: WIDE, name: 'Wide' }
  );
  document = addConfigurationRow(document, { rowId: NARROW, name: 'Narrow' });
  document = addConfigurationRow(document, { rowId: BARE, name: 'Bare' });
  return { ...document, bodyOrder: [bodyId] };
})();

function configured(active: string): ProjectDocument {
  return {
    ...project,
    configurations: { ...project.configurations!, activeRowId: active }
  };
}

/** The plate's bottom front edge, (0,0,0)–(width,0,0), measured across. */
function across(viewId: DrawingViewId, id: string): DrawingLinearDimension {
  return {
    annotationId: id as DrawingAnnotationId,
    kind: 'linear',
    viewId,
    direction: 'horizontal',
    from: { edge: { bodyId, hash: 200 }, anchor: 'first' },
    to: { edge: { bodyId, hash: 200 }, anchor: 'second' },
    placementMm: { x: 0, y: -20 }
  };
}

/**
 * An A3 sheet of two Front views made while Wide is active: one on the
 * active row, one pinned to Narrow, each with a dimension across the plate.
 */
function twoFronts(activeRow = WIDE): DrawingSheet {
  const fingerprint = drawingSourceFingerprint(
    { [bodyId]: plate(WIDTHS[activeRow]!) },
    [bodyId]
  )!;
  const sheet = createStarterSheet({
    name: 'Sheet 1',
    bodyIds: [bodyId],
    bodies: { [bodyId]: plate(70) },
    units: 'mm',
    paper: { size: 'A3', orientation: 'landscape' },
    projectionAngle: 'first',
    fingerprint
  });
  const front = sheet.views.find((view) => view.orientation === 'front')!;
  const active: DrawingView = { ...front, centerMm: { x: 120, y: 150 } };
  const pinned: DrawingView = {
    ...active,
    viewId: 'dview_narrow' as DrawingViewId,
    centerMm: { x: 280, y: 150 },
    configurationId: NARROW
  };
  return {
    ...sheet,
    scale: { numerator: 1, denominator: 1 },
    views: [active, pinned],
    annotations: [
      across(active.viewId, 'dann_a'),
      across(pinned.viewId, 'dann_b')
    ]
  };
}

type Props = Parameters<typeof DrawingWorkspace>[0];

function workspace(
  document: ProjectDocument,
  {
    requestBodies = true,
    requestSection,
    onCommand = vi.fn(() => true)
  }: {
    requestBodies?: boolean;
    requestSection?: Props['requestSection'];
    onCommand?: Props['onCommand'];
  } = {}
) {
  return (
    <DrawingWorkspace
      document={document}
      bodies={rowBodies(document)}
      geometryPending={false}
      defaultBodyIds={[bodyId]}
      requestTessellation={tessellate}
      {...(requestSection ? { requestSection } : {})}
      {...(requestBodies
        ? {
            requestBodies: (row: ProjectDocument) =>
              Promise.resolve(rowBodies(row))
          }
        : {})}
      editDisabledReason={null}
      onCommand={onCommand}
      onStatus={vi.fn()}
    />
  );
}

/** The text of every SVG `<text>`. */
function svgTexts(svg: string): string[] {
  return [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]!);
}

/** The value of every DXF TEXT entity. */
function dxfTexts(dxf: string): string[] {
  const lines = dxf.split(/\r?\n/).map((line) => line.trim());
  const out: string[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2)
    if (lines[i] === '0' && lines[i + 1] === 'TEXT') {
      for (let j = i + 2; j + 1 < lines.length && lines[j] !== '0'; j += 2)
        if (lines[j] === '1') out.push(lines[j + 1]!);
    }
  return out;
}

async function exported(format: 'SVG' | 'DXF'): Promise<string> {
  const before = saved.length;
  const button = screen.getByRole('button', { name: `Export ${format}` });
  await waitFor(() => expect(button).not.toBeDisabled());
  await userEvent.click(button);
  await waitFor(() => expect(saved.length).toBe(before + 1));
  return saved[saved.length - 1]!.text;
}

async function drawn(views = 2): Promise<HTMLElement> {
  const canvas = screen.getByRole('application', { name: 'Sheet Sheet 1' });
  await waitFor(() =>
    expect(canvas.querySelectorAll('.drawing-view')).toHaveLength(views)
  );
  await waitFor(() =>
    expect(
      canvas.querySelectorAll('.drawing-view.is-placeholder')
    ).toHaveLength(0)
  );
  return canvas;
}

describe('DrawingWorkspace: views pinned to a configuration row', () => {
  beforeEach(() => {
    resetRetainedProjections();
    saved.length = 0;
  });
  afterEach(cleanup);

  it('dimensions and exports each view at its own row’s width (#2111)', async () => {
    render(
      workspace({ ...configured(WIDE), drawings: { sheets: [twoFronts()] } })
    );
    const canvas = await drawn();
    await within(canvas).findByRole('button', {
      name: 'Horizontal dimension 70'
    });
    // The Narrow view's dimension reads the Narrow plate, not the active
    // Wide one it shares its edge's identity with.
    await within(canvas).findByRole('button', {
      name: 'Horizontal dimension 40'
    });
    const svg = svgTexts(await exported('SVG'));
    expect(svg).toContain('70');
    expect(svg).toContain('40');
    const dxf = dxfTexts(await exported('DXF'));
    expect(dxf).toContain('70');
    expect(dxf).toContain('40');
  });

  it('keeps both widths when the model switches to the pinned row', async () => {
    // Narrow active: both views draw Narrow, the pinned one as its own row
    // and the other as the model's.
    render(
      workspace({
        ...configured(NARROW),
        drawings: { sheets: [twoFronts(NARROW)] }
      })
    );
    const canvas = await drawn();
    await waitFor(() =>
      expect(
        within(canvas).getAllByRole('button', {
          name: 'Horizontal dimension 40'
        })
      ).toHaveLength(2)
    );
  });

  it('never measures a pinned view from the active row when its row’s bodies are unavailable', async () => {
    render(
      workspace(
        { ...configured(WIDE), drawings: { sheets: [twoFronts()] } },
        { requestBodies: false }
      )
    );
    const canvas = await drawn();
    await within(canvas).findByRole('button', {
      name: 'Horizontal dimension 70'
    });
    // Broken, not 70: the active row is no stand-in for Narrow.
    expect(
      within(canvas).queryAllByRole('button', {
        name: 'Horizontal dimension 70'
      })
    ).toHaveLength(1);
    expect(
      within(canvas).queryByRole('button', { name: 'Horizontal dimension 40' })
    ).toBeNull();
    expect(screen.getByRole('button', { name: 'Export SVG' })).toBeDisabled();
  });

  it('keeps a stale sheet’s views on the rows they drew, and exports them as drawn (#2113)', async () => {
    const sheet = twoFronts();
    const first = render(
      workspace({ ...configured(WIDE), drawings: { sheets: [sheet] } })
    );
    const before = await drawn();
    await within(before).findByRole('button', {
      name: 'Horizontal dimension 40'
    });
    await within(before).findByRole('button', {
      name: 'Horizontal dimension 70'
    });
    first.unmount();
    // The model switches to Narrow; the sheet is not updated.
    render(workspace({ ...configured(NARROW), drawings: { sheets: [sheet] } }));
    expect(screen.getByRole('status')).toHaveTextContent('Model changed');
    const canvas = await drawn();
    // Each view keeps what it drew: the active-row view Wide's 70 mm, the
    // pinned one Narrow's 40 mm. Neither takes the other's drawing.
    expect(
      within(canvas).getByRole('button', { name: 'Horizontal dimension 70' })
    ).toBeTruthy();
    expect(
      within(canvas).getByRole('button', { name: 'Horizontal dimension 40' })
    ).toBeTruthy();
    const svg = await exported('SVG');
    expect(svgTexts(svg)).toEqual(expect.arrayContaining(['70', '40']));
    // The outlines exported are those widths too: 70 and 40 paper mm at 1:1.
    const spans = [...svg.matchAll(/<polyline[^>]*points="([^"]+)"/g)].map(
      (m) => {
        const xs = m[1]!
          .trim()
          .split(/\s+/)
          .map((pair) => Number(pair.split(',')[0]));
        return Math.round(Math.max(...xs) - Math.min(...xs));
      }
    );
    expect(spans).toContain(70);
    expect(spans).toContain(40);
  });

  it('checks and Auto-dimensions a pinned view from its own row (#2236)', async () => {
    // Wide is active; the sheet's only views draw Narrow.
    const base = twoFronts();
    const pinned = base.views[1]!;
    const sheet: DrawingSheet = {
      ...base,
      source: { fingerprint: 'v1:any' },
      views: [pinned],
      annotations: []
    };
    const onCommand = vi.fn<Props['onCommand']>(() => true);
    const document = { ...configured(WIDE), drawings: { sheets: [sheet] } };
    const first = render(workspace(document, { onCommand }));
    await drawn(1);
    const missing = await screen.findByRole('list', {
      name: 'Missing dimensions'
    });
    const asked = within(missing)
      .getAllByRole('listitem')
      .map((item) => item.textContent ?? '');
    // The face the Narrow plate has, never the active Wide plate's.
    expect(asked.some((text) => text.includes('x = 40'))).toBe(true);
    expect(asked.some((text) => text.includes('x = 70'))).toBe(false);
    const auto = screen.getByRole('button', { name: 'Auto-dimension' });
    await waitFor(() => expect(auto).toBeEnabled());
    await userEvent.click(auto);
    const preview = screen.getByRole('group', {
      name: 'Auto-dimension preview'
    });
    await userEvent.click(
      within(preview).getByRole('button', { name: 'Apply' })
    );
    const added = onCommand.mock.calls[0]![0].commands!.map(
      (entry) =>
        (entry as { payload: { annotation: DrawingAnnotation } }).payload
          .annotation
    );
    expect(added.length).toBeGreaterThan(0);
    first.unmount();
    // The applied sheet states 40, and exports 40, nowhere 70.
    render(
      workspace({
        ...document,
        drawings: { sheets: [{ ...sheet, annotations: added }] }
      })
    );
    const canvas = await drawn(1);
    await within(canvas).findByRole('button', {
      name: 'Horizontal dimension 40'
    });
    expect(
      within(canvas).queryByRole('button', { name: /dimension 70$/ })
    ).toBeNull();
    const texts = svgTexts(await exported('SVG'));
    expect(texts).toContain('40');
    expect(texts).not.toContain('70');
    expect(
      await screen.findByText(/Every size and position it reads is stated once/)
    ).toBeTruthy();
  });

  it('measures a pinned section while the active row suppresses its body (#2235)', async () => {
    // Bare is active and builds no plate; the Front draws Wide, and its
    // section inherits Wide.
    const base = twoFronts();
    const front: DrawingView = { ...base.views[0]!, configurationId: WIDE };
    const section: DrawingView = {
      viewId: 'dvw_section' as DrawingViewId,
      orientation: 'right',
      bodyIds: [bodyId],
      centerMm: { x: front.centerMm.x + 140, y: front.centerMm.y },
      hiddenLines: false,
      section: { sourceViewId: front.viewId, label: 'A', depth: -35 }
    };
    // The Wide plate's x <= 35 half, cut at x = 35.
    const whole = plate(70);
    const clip = (values: ArrayLike<number>) =>
      Array.from(values, (value, index) =>
        index % 3 === 0 ? Math.min(value, 35) : value
      );
    const half = {
      ...projectionBodyInput({
        ...whole,
        mesh: {
          ...whole.mesh,
          vertices: Float32Array.from(clip(whole.mesh.vertices))
        }
      })!,
      cutFaces: [4],
      edgeTopology: whole.topology!.edges.map((edge) => ({
        ...edge,
        points: clip(edge.points)
      }))
    };
    const requestSection = vi.fn(() => Promise.resolve({ [bodyId]: half }));
    // The cut edge across the plate's depth, (35,0,0)–(35,28,0).
    const depth: DrawingLinearDimension = {
      ...across(section.viewId, 'dann_cut'),
      from: { edge: { bodyId, hash: 201 }, anchor: 'first' },
      to: { edge: { bodyId, hash: 201 }, anchor: 'second' }
    };
    const sheet: DrawingSheet = {
      ...base,
      source: { fingerprint: 'v1:any' },
      views: [front, section],
      annotations: [across(front.viewId, 'dann_front'), depth]
    };
    render(
      workspace(
        { ...configured(BARE), drawings: { sheets: [sheet] } },
        { requestSection }
      )
    );
    const canvas = await drawn(2);
    await within(canvas).findByRole('button', {
      name: 'Horizontal dimension 70'
    });
    await within(canvas).findByRole('button', {
      name: 'Horizontal dimension 28'
    });
    const texts = svgTexts(await exported('SVG'));
    expect(texts).toEqual(expect.arrayContaining(['70', '28']));
  });
});
