import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  activateConfiguration,
  addConfigurationColumn,
  addConfigurationRow,
  addPrimitiveFeature,
  createConfigurations,
  createProjectDocument,
  getParameterScope,
  holeBody,
  listFeaturesInOrder,
  listParameters,
  setConfigurationCell,
  setParameter
} from '@openzcad/document-core';
import {
  toUserId,
  type BodyId,
  type BodyRepresentation,
  type DrawingAnnotation,
  type DrawingAnnotationId,
  type DrawingLinearDimension,
  type DrawingSheet,
  type DrawingSheetId,
  type DrawingView,
  type DrawingViewId,
  type FeatureId,
  type ProjectDocument
} from '@openzcad/shared';
import {
  DrawingWorkspace,
  resetRetainedProjections,
  retainedRowBodyIds
} from './DrawingWorkspace';
import {
  createStarterSheet,
  drawingSourceFingerprint,
  projectionBodyInput,
  sheetFenceParts
} from '../lib/drawing/sheetSources';
import { rowFencedFingerprint } from '../lib/drawing/viewConfigurations';
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

type Build = (document: ProjectDocument) => Record<string, BodyRepresentation>;

const tessellateWith =
  (build: Build) =>
  (
    document: ProjectDocument,
    bodyIds: BodyId[]
  ): Promise<Record<string, ProjectionBodyInput>> => {
    const bodies = build(document);
    return Promise.resolve(
      Object.fromEntries(
        bodyIds.flatMap((id) => {
          const input = bodies[id] ? projectionBodyInput(bodies[id]) : null;
          return input ? [[id, input]] : [];
        })
      )
    );
  };

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

/**
 * `sheet` saved as drawn of `document`: fenced to what each row its views
 * name builds there, as a sheet drawn or Updated in the workspace is.
 */
function fenced(
  sheet: DrawingSheet,
  document: ProjectDocument = project
): DrawingSheet {
  return {
    ...sheet,
    source: {
      fingerprint: rowFencedFingerprint(
        sheetFenceParts(sheet.source.fingerprint).base,
        sheet,
        document
      )
    }
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
  return fenced({
    ...sheet,
    scale: { numerator: 1, denominator: 1 },
    views: [active, pinned],
    annotations: [
      across(active.viewId, 'dann_a'),
      across(pinned.viewId, 'dann_b')
    ]
  });
}

type Props = Parameters<typeof DrawingWorkspace>[0];

function workspace(
  document: ProjectDocument,
  {
    requestBodies = true,
    requestSection,
    onCommand = vi.fn(() => true),
    onStatus = vi.fn(),
    build = rowBodies
  }: {
    /** False for none; a function to answer a row's bodies another way. */
    requestBodies?: boolean | NonNullable<Props['requestBodies']>;
    requestSection?: Props['requestSection'];
    onCommand?: Props['onCommand'];
    onStatus?: Props['onStatus'];
    /** What a row's document builds. */
    build?: Build;
  } = {}
) {
  return (
    <DrawingWorkspace
      document={document}
      bodies={build(document)}
      geometryPending={false}
      defaultBodyIds={[bodyId]}
      requestTessellation={tessellateWith(build)}
      {...(requestSection ? { requestSection } : {})}
      {...(requestBodies
        ? {
            requestBodies:
              typeof requestBodies === 'function'
                ? requestBodies
                : (row: ProjectDocument) =>
                    Promise.resolve({ bodies: build(row) })
          }
        : {})}
      editDisabledReason={null}
      onCommand={onCommand}
      onStatus={onStatus}
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

/** `sheet` as the last command, an Update, rebinds it. */
function updatedSheet(
  sheet: DrawingSheet,
  onCommand: { mock: { calls: Parameters<Props['onCommand']>[] } }
): DrawingSheet {
  const { payload } = onCommand.mock.calls.at(-1)![0] as {
    payload: { sheetId: DrawingSheetId; source: DrawingSheet['source'] };
  };
  expect(payload.sheetId).toBe(sheet.sheetId);
  expect(payload.source.fingerprint).not.toBe(sheet.source.fingerprint);
  return { ...sheet, source: payload.source };
}

async function drawn(views = 2, sheet = 'Sheet 1'): Promise<HTMLElement> {
  const canvas = await screen.findByRole('application', {
    name: `Sheet ${sheet}`
  });
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
    const sheet = fenced({
      ...base,
      source: { fingerprint: 'v1:any' },
      views: [pinned],
      annotations: []
    });
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
    const sheet = fenced({
      ...base,
      source: { fingerprint: 'v1:any' },
      views: [front, section],
      annotations: [across(front.viewId, 'dann_front'), depth]
    });
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

/**
 * Review of #2426: what else a pinned view reads from its row (hole sizes),
 * what its cache key must cover (the feature order), a row the model cannot
 * take, a check run before a row's geometry is in, and how much of a row's
 * build is kept.
 */
describe('DrawingWorkspace: pinned rows read, key, fail and keep their own row', () => {
  beforeEach(() => {
    resetRetainedProjections();
    saved.length = 0;
  });
  afterEach(cleanup);

  /**
   * A plate drilled with one through hole of diameter `bore`: 10 in Wide,
   * 6 in Narrow. The plate is `60 + bore` wide, so a row's body is its own.
   */
  const holed = (() => {
    let document = setParameter(
      createProjectDocument('Drilled', toUserId('test')),
      { name: 'bore', expression: '10' }
    );
    document = addPrimitiveFeature(document, {
      name: 'Plate',
      primitiveKind: 'box',
      dimensions: { width: 70, height: 28, depth: 7 }
    });
    const drilled = holeBody(document, {
      name: 'Hole',
      targetBodyId: document.bodyOrder.at(-1)!,
      faceHash: 101,
      style: 'simple',
      diameter: 'bore',
      depthMode: 'through',
      position: { u: 0, v: 0 }
    });
    document = drilled.document;
    const column = {
      kind: 'parameter' as const,
      parameterId: listParameters(document)[0]!.parameterId
    };
    document = createConfigurations(document, { rowId: WIDE, name: 'Wide' });
    document = addConfigurationColumn(document, { column });
    document = addConfigurationRow(document, { rowId: NARROW, name: 'Narrow' });
    document = setConfigurationCell(document, {
      rowId: NARROW,
      column,
      value: '6'
    });
    return {
      document,
      column,
      bodyId: drilled.bodyId,
      holeId: listFeaturesInOrder(document).at(-1)!.featureId
    };
  })();

  /** What a row of `holed` builds: the plate with its bore, at its size. */
  const holedBodies: Build = (document) => {
    const bore = getParameterScope(document).scope.bore!;
    const base = plate(60 + bore);
    return {
      [holed.bodyId]: {
        ...base,
        bodyId: holed.bodyId,
        topology: {
          ...base.topology!,
          faces: [
            ...base.topology!.faces,
            {
              topologyId: 'f_bore',
              hash: 150,
              triangleStart: 0,
              triangleCount: 0,
              reference: {
                kind: 'face',
                producingFeatureId: holed.holeId,
                lineageName: 'hole.face.bore'
              } as never,
              geometry: {
                surfaceType: 'cylinder',
                area: Math.PI * bore * 7,
                center: { x: 20, y: 14, z: 3.5 },
                axisStart: { x: 20, y: 14, z: 0 },
                axisEnd: { x: 20, y: 14, z: 7 },
                radius: bore / 2
              }
            }
          ]
        }
      }
    };
  };

  const top = (id: string, row?: string): DrawingView => ({
    viewId: id as DrawingViewId,
    orientation: 'top',
    bodyIds: [holed.bodyId],
    centerMm: { x: row ? 280 : 120, y: 150 },
    hiddenLines: false,
    ...(row ? { configurationId: row } : {})
  });

  const holeTable = (viewId: DrawingViewId, id: string): DrawingAnnotation => ({
    annotationId: id as DrawingAnnotationId,
    kind: 'hole-table',
    viewId,
    placementMm: { x: -40, y: -60 }
  });

  /** A sheet of `views` of the drilled plate, each with its hole table. */
  const holeSheet = (
    document: ProjectDocument,
    views: DrawingView[]
  ): DrawingSheet =>
    fenced(
      {
        ...twoFronts(),
        source: {
          fingerprint: drawingSourceFingerprint(holedBodies(document), [
            holed.bodyId
          ])!
        },
        views,
        annotations: views.map((view, index) =>
          holeTable(view.viewId, `dann_holes_${index}`)
        )
      },
      document
    );

  it('sizes a pinned view’s hole table from its own row, not the active one', async () => {
    // Wide (Ø10) is active; the sheet's only view draws Narrow's Ø6 bore.
    const sheet = holeSheet(holed.document, [top('dview_narrow', NARROW)]);
    render(
      workspace(
        { ...holed.document, drawings: { sheets: [sheet] } },
        { build: holedBodies }
      )
    );
    await drawn(1);
    const svg = svgTexts(await exported('SVG'));
    expect(svg).toContain('Ø6 THRU');
    expect(svg).not.toContain('Ø10 THRU');
    const dxf = dxfTexts(await exported('DXF')).join('\n');
    expect(dxf).toMatch(/6 THRU/);
    expect(dxf).not.toMatch(/10 THRU/);
  });

  it('keeps a stale sheet’s hole sizes as each row drew them', async () => {
    const sheet = holeSheet(holed.document, [
      top('dview_wide'),
      top('dview_narrow', NARROW)
    ]);
    const first = render(
      workspace(
        { ...holed.document, drawings: { sheets: [sheet] } },
        { build: holedBodies }
      )
    );
    await drawn();
    expect(svgTexts(await exported('SVG'))).toEqual(
      expect.arrayContaining(['Ø10 THRU', 'Ø6 THRU'])
    );
    first.unmount();
    // Both rows are resized; the sheet is not updated.
    let edited = setConfigurationCell(holed.document, {
      rowId: WIDE,
      column: holed.column,
      value: '12'
    });
    edited = setConfigurationCell(edited, {
      rowId: NARROW,
      column: holed.column,
      value: '4'
    });
    render(
      workspace(
        { ...edited, drawings: { sheets: [sheet] } },
        { build: holedBodies }
      )
    );
    expect(screen.getByRole('status')).toHaveTextContent('Model changed');
    await drawn();
    const texts = svgTexts(await exported('SVG'));
    expect(texts).toEqual(expect.arrayContaining(['Ø10 THRU', 'Ø6 THRU']));
    expect(texts).not.toContain('Ø12 THRU');
    expect(texts).not.toContain('Ø4 THRU');
  });

  it('redraws a pinned-only sheet from a changed feature order once it is Updated', async () => {
    // Narrow builds 40 mm wide with feat_a first, 55 mm with feat_b first:
    // two steps whose order decides the result.
    const build: Build = (document) =>
      document.configurations!.activeRowId === NARROW
        ? { [bodyId]: plate(document.featureOrder[0] === 'feat_a' ? 40 : 55) }
        : rowBodies(document);
    const pinned = twoFronts().views[1]!;
    const ordered = (...featureOrder: string[]): ProjectDocument => ({
      ...configured(WIDE),
      featureOrder: featureOrder as FeatureId[]
    });
    const sheet = fenced(
      {
        ...twoFronts(),
        source: { fingerprint: 'v1:any' },
        views: [pinned],
        annotations: [across(pinned.viewId, 'dann_b')]
      },
      ordered('feat_a', 'feat_b')
    );
    const onCommand = vi.fn<Props['onCommand']>(() => true);
    const drawing = (document: ProjectDocument, drawn: DrawingSheet) =>
      workspace(
        { ...document, drawings: { sheets: [drawn] } },
        { build, onCommand }
      );
    const view = render(drawing(ordered('feat_a', 'feat_b'), sheet));
    const canvas = await drawn(1);
    await within(canvas).findByRole('button', {
      name: 'Horizontal dimension 40'
    });
    // The order changes what Narrow builds: the sheet is outdated, and
    // keeps (and exports) the drawing it made until it is Updated.
    const reordered = ordered('feat_b', 'feat_a');
    view.rerender(drawing(reordered, sheet));
    await screen.findByText('Model changed');
    await drawn(1);
    expect(
      within(canvas).getByRole('button', { name: 'Horizontal dimension 40' })
    ).toBeTruthy();
    const before = svgTexts(await exported('SVG'));
    expect(before).toContain('40');
    expect(before).not.toContain('55');
    await userEvent.click(screen.getByRole('button', { name: 'Update' }));
    view.rerender(drawing(reordered, updatedSheet(sheet, onCommand)));
    await within(canvas).findByRole('button', {
      name: 'Horizontal dimension 55'
    });
    await drawn(1);
    expect(screen.queryByText('Model changed')).toBeNull();
    const texts = svgTexts(await exported('SVG'));
    expect(texts).toContain('55');
    expect(texts).not.toContain('40');
  });

  it('reports a row the model cannot take on its own views, and draws the rest', async () => {
    // Narrow's width names a parameter the model no longer has.
    let document = setParameter(
      createProjectDocument('Bracket', toUserId('test')),
      { name: 'width', expression: '70' }
    );
    const column = {
      kind: 'parameter' as const,
      parameterId: listParameters(document)[0]!.parameterId
    };
    document = createConfigurations(document, { rowId: WIDE, name: 'Wide' });
    document = addConfigurationColumn(document, { column });
    document = addConfigurationRow(document, { rowId: NARROW, name: 'Narrow' });
    const set = document.configurations!;
    const broken: ProjectDocument = {
      ...document,
      bodyOrder: [bodyId],
      configurations: {
        ...set,
        rows: set.rows.map((row) =>
          row.id === NARROW
            ? {
                ...row,
                parameters: {
                  ...row.parameters,
                  [column.parameterId]: 'deleted_name * 2'
                }
              }
            : row
        )
      },
      drawings: { sheets: [twoFronts()] }
    };
    broken.drawings = { sheets: [fenced(twoFronts(), broken)] };
    render(workspace(broken));
    const canvas = screen.getByRole('application', { name: 'Sheet Sheet 1' });
    // The active row's view is drawn and dimensioned as ever.
    await within(canvas).findByRole('button', {
      name: 'Horizontal dimension 70'
    });
    // The Narrow view says why it is not, by its row.
    await within(canvas).findByText(/Front — Configuration "Narrow"/);
    // Nor is a sheet whose export that holds back called up to date.
    expect(screen.queryByText('Drawing up to date')).toBeNull();
    expect(
      within(canvas).queryByRole('button', { name: 'Horizontal dimension 40' })
    ).toBeNull();
  });

  it('leaves a pinned view unchecked until its row’s geometry is in', async () => {
    const pinned = twoFronts().views[1]!;
    const sheet = fenced({
      ...twoFronts(),
      source: { fingerprint: 'v1:any' },
      views: [pinned],
      annotations: []
    });
    let release!: () => void;
    const built = new Promise<void>((resolve) => {
      release = resolve;
    });
    render(
      workspace(
        { ...configured(WIDE), drawings: { sheets: [sheet] } },
        {
          requestBodies: (row) => built.then(() => ({ bodies: rowBodies(row) }))
        }
      )
    );
    // Narrow is still building: nothing of it has been read, so the sheet
    // is not called complete.
    const unread = await screen.findByRole('list', {
      name: 'Views not checked'
    });
    expect(unread).toHaveTextContent('Front: its configuration is still');
    expect(screen.queryByText(/Every size and position/)).toBeNull();
    await act(async () => {
      release();
      await built;
    });
    const missing = await screen.findByRole('list', {
      name: 'Missing dimensions'
    });
    expect(missing).toHaveTextContent('x = 40');
    expect(
      screen.queryByRole('list', { name: 'Views not checked' })
    ).toBeNull();
  });

  it('keeps only the bodies a row’s views draw', async () => {
    // The row's build answers with the whole model: a large part no view
    // of the sheet draws comes with it.
    const other = { ...plate(500), bodyId: 'body_other' as BodyId };
    render(
      workspace(
        { ...configured(WIDE), drawings: { sheets: [twoFronts()] } },
        {
          requestBodies: (row) =>
            Promise.resolve({
              bodies: { ...rowBodies(row), body_other: other }
            })
        }
      )
    );
    const canvas = await drawn();
    await within(canvas).findByRole('button', {
      name: 'Horizontal dimension 40'
    });
    const held = retainedRowBodyIds(project.projectId);
    expect(Object.values(held.cached)).toEqual([[bodyId]]);
    expect(held.kept.flatMap((drawing) => Object.values(drawing))).toEqual([
      [bodyId]
    ]);
  });

  it('lets a sheet off screen go past the budget, and builds its row again when shown', async () => {
    resetRetainedProjections({ inactiveRowBodiesBytes: 0 });
    // Bare is active; one sheet draws Narrow, the other Wide.
    const front = twoFronts().views[0]!;
    const sheetOf = (
      name: string,
      row: string,
      dimension: string
    ): DrawingSheet => {
      const view: DrawingView = {
        ...front,
        viewId: `dview_${row}` as DrawingViewId,
        configurationId: row
      };
      return fenced({
        ...twoFronts(),
        sheetId: `dsht_${row}` as DrawingSheetId,
        name,
        source: { fingerprint: 'v1:any' },
        views: [view],
        annotations: [across(view.viewId, dimension)]
      });
    };
    const requestBodies = vi.fn((row: ProjectDocument) =>
      Promise.resolve({ bodies: rowBodies(row) })
    );
    const builds = (row: string) =>
      requestBodies.mock.calls.filter(
        ([document]) => document.configurations!.activeRowId === row
      ).length;
    render(
      workspace(
        {
          ...configured(BARE),
          drawings: {
            sheets: [
              sheetOf('Sheet 1', NARROW, 'dann_n'),
              sheetOf('Sheet 2', WIDE, 'dann_w')
            ]
          }
        },
        { requestBodies }
      )
    );
    await within(await drawn(1)).findByRole('button', {
      name: 'Horizontal dimension 40'
    });
    expect(builds(NARROW)).toBe(1);
    await userEvent.click(screen.getByRole('tab', { name: 'Sheet 2' }));
    await within(await drawn(1, 'Sheet 2')).findByRole('button', {
      name: 'Horizontal dimension 70'
    });
    // Sheet 1 is off screen and over budget: neither the row cache nor a
    // kept drawing holds Narrow's bodies any more.
    await waitFor(() => {
      const held = retainedRowBodyIds(project.projectId);
      expect(Object.keys(held.cached)).toHaveLength(1);
      expect(held.kept).toHaveLength(1);
    });
    await userEvent.click(screen.getByRole('tab', { name: 'Sheet 1' }));
    await within(await drawn(1)).findByRole('button', {
      name: 'Horizontal dimension 40'
    });
    expect(builds(NARROW)).toBe(2);
  });
});

/**
 * Re-check of #2426: a sheet is stale by what each row it draws builds,
 * whichever row is active; a row build that comes in late is counted
 * against the budget; a body no view draws any more is let go; and a view
 * whose row does not build its body is reported unchecked.
 */
describe('DrawingWorkspace: pinned rows stay fenced, bounded and reported', () => {
  beforeEach(() => {
    resetRetainedProjections();
    saved.length = 0;
  });
  afterEach(cleanup);

  const THIRD = 'row_third';

  /** A plate as wide as `width`: 70 in Wide, 40 in Narrow, 55 in Third. */
  const sized = (() => {
    let document = setParameter(
      createProjectDocument('Sized', toUserId('test')),
      { name: 'width', expression: '70' }
    );
    const column = {
      kind: 'parameter' as const,
      parameterId: listParameters(document)[0]!.parameterId
    };
    document = createConfigurations(document, { rowId: WIDE, name: 'Wide' });
    document = addConfigurationColumn(document, { column });
    for (const [rowId, name, value] of [
      [NARROW, 'Narrow', '40'],
      [THIRD, 'Third', '55']
    ] as const) {
      document = addConfigurationRow(document, { rowId, name });
      document = setConfigurationCell(document, { rowId, column, value });
    }
    return { document: { ...document, bodyOrder: [bodyId] }, column };
  })();

  const sizedBodies: Build = (document) => ({
    [bodyId]: plate(getParameterScope(document).scope.width!)
  });

  /** A Front on each of `rows` (the model's row for null), dimensioned. */
  const fronts = (...rows: (string | null)[]): DrawingSheet => {
    const base = twoFronts();
    const views = rows.map((row, index): DrawingView => ({
      ...base.views[0]!,
      viewId: `dvw_${row ?? 'model'}` as DrawingViewId,
      centerMm: { x: 120 + index * 160, y: 150 },
      ...(row ? { configurationId: row } : {})
    }));
    return fenced(
      {
        ...base,
        source: {
          fingerprint: drawingSourceFingerprint(sizedBodies(sized.document), [
            bodyId
          ])!
        },
        views,
        annotations: views.map((view, index) =>
          across(view.viewId, `dann_${index}`)
        )
      },
      sized.document
    );
  };

  const sizedWorkspace = (
    document: ProjectDocument,
    sheet: DrawingSheet,
    options: Parameters<typeof workspace>[1] = {}
  ) =>
    workspace(
      { ...document, drawings: { sheets: [sheet] } },
      { build: sizedBodies, ...options }
    );

  const dimension = (canvas: HTMLElement, value: number) =>
    within(canvas).queryByRole('button', {
      name: `Horizontal dimension ${value}`
    });

  /** Wide resized to 90 mm while it is active. */
  const resized = () =>
    setConfigurationCell(sized.document, {
      rowId: WIDE,
      column: sized.column,
      value: '90'
    });

  it('keeps a sheet stale when another row is made active, and exports it as drawn', async () => {
    // Drawn while Wide is active: one view on Wide, one on Narrow.
    const sheet = fronts(WIDE, NARROW);
    const first = render(sizedWorkspace(sized.document, sheet));
    const before = await drawn();
    await waitFor(() => expect(dimension(before, 70)).toBeTruthy());
    await waitFor(() => expect(dimension(before, 40)).toBeTruthy());
    expect(screen.queryByText('Model changed')).toBeNull();
    first.unmount();
    // Wide is resized: the sheet is stale.
    const second = render(sizedWorkspace(resized(), sheet));
    await screen.findByText('Model changed');
    second.unmount();
    // A third row is made active, so every view now draws another row. The
    // sheet is no more current than it was: it shows and exports the
    // drawing it made, never the resized Wide as if it had been Updated.
    const third = activateConfiguration(resized(), { rowId: THIRD });
    const onCommand = vi.fn<Props['onCommand']>(() => true);
    const view = render(sizedWorkspace(third, sheet, { onCommand }));
    await screen.findByText('Model changed');
    const canvas = await drawn();
    expect(dimension(canvas, 70)).toBeTruthy();
    expect(dimension(canvas, 40)).toBeTruthy();
    expect(dimension(canvas, 90)).toBeNull();
    const kept = svgTexts(await exported('SVG'));
    expect(kept).toEqual(expect.arrayContaining(['70', '40']));
    expect(kept).not.toContain('90');
    // Updated, it draws Wide as it is now.
    await userEvent.click(screen.getByRole('button', { name: 'Update' }));
    view.rerender(
      sizedWorkspace(third, updatedSheet(sheet, onCommand), { onCommand })
    );
    await waitFor(() => expect(dimension(canvas, 90)).toBeTruthy());
    await drawn();
    expect(screen.queryByText('Model changed')).toBeNull();
    const texts = svgTexts(await exported('SVG'));
    expect(texts).toEqual(expect.arrayContaining(['90', '40']));
    expect(texts).not.toContain('70');
  });

  it('draws nothing of a stale sheet’s rows once its kept drawing is gone', async () => {
    const sheet = fronts(WIDE, NARROW);
    const first = render(sizedWorkspace(sized.document, sheet));
    await drawn();
    first.unmount();
    // The kept drawing is evicted (a reload does the same).
    resetRetainedProjections();
    const requestBodies = vi.fn((row: ProjectDocument) =>
      Promise.resolve({ bodies: sizedBodies(row) })
    );
    render(
      sizedWorkspace(
        activateConfiguration(resized(), { rowId: THIRD }),
        sheet,
        {
          requestBodies
        }
      )
    );
    await screen.findByText('Model changed');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    // Nothing is built or drawn from the current rows until an Update.
    const canvas = screen.getByRole('application', { name: 'Sheet Sheet 1' });
    expect(requestBodies).not.toHaveBeenCalled();
    expect(dimension(canvas, 90)).toBeNull();
    expect(
      canvas.querySelectorAll('.drawing-view.is-placeholder')
    ).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Export SVG' })).toBeDisabled();
  });

  it('is stale once a row it draws is edited, though the model’s bodies are as drawn', async () => {
    // Wide is active and stays as it is; only Narrow's cell changes.
    const sheet = fronts(null, NARROW);
    const first = render(sizedWorkspace(sized.document, sheet));
    const before = await drawn();
    await waitFor(() => expect(dimension(before, 40)).toBeTruthy());
    first.unmount();
    const edited = setConfigurationCell(sized.document, {
      rowId: NARROW,
      column: sized.column,
      value: '45'
    });
    render(sizedWorkspace(edited, sheet));
    await screen.findByText('Model changed');
    const canvas = await drawn();
    expect(dimension(canvas, 40)).toBeTruthy();
    expect(dimension(canvas, 45)).toBeNull();
    const texts = svgTexts(await exported('SVG'));
    expect(texts).toContain('40');
    expect(texts).not.toContain('45');
  });

  it('stays current through a row switch that changes nothing it draws', async () => {
    // Every view draws Narrow; the model goes from Wide to Third.
    const sheet = fronts(NARROW);
    const view = render(sizedWorkspace(sized.document, sheet));
    const canvas = await drawn(1);
    await waitFor(() => expect(dimension(canvas, 40)).toBeTruthy());
    view.rerender(
      sizedWorkspace(
        activateConfiguration(sized.document, { rowId: THIRD }),
        sheet
      )
    );
    await drawn(1);
    await waitFor(() => expect(dimension(canvas, 40)).toBeTruthy());
    expect(screen.queryByText('Model changed')).toBeNull();
    // Renaming a row, or editing one the sheet does not draw, keeps it too.
    const other = setConfigurationCell(sized.document, {
      rowId: THIRD,
      column: sized.column,
      value: '60'
    });
    view.rerender(sizedWorkspace(other, sheet));
    await drawn(1);
    expect(screen.queryByText('Model changed')).toBeNull();
  });

  it('asks for an Update of a sheet saved without its rows’ content', async () => {
    // As saved before sheets were fenced to their rows: what Narrow built
    // when it was drawn is unknown, so it is not called current.
    const sheet: DrawingSheet = {
      ...fronts(NARROW),
      source: { fingerprint: 'v1:any' }
    };
    const requestBodies = vi.fn((row: ProjectDocument) =>
      Promise.resolve({ bodies: sizedBodies(row) })
    );
    render(sizedWorkspace(sized.document, sheet, { requestBodies }));
    await screen.findByText('Model changed');
    expect(screen.getByRole('button', { name: 'Update' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Export SVG' })).toBeDisabled();
    expect(requestBodies).not.toHaveBeenCalled();
  });

  /**
   * Each row's build, with Narrow's plate standing in for its third bore
   * while `fails` says the bore fails there (#2382).
   */
  const boreFailsInNarrow =
    (fails: () => boolean = () => true): NonNullable<Props['requestBodies']> =>
    (row) =>
      Promise.resolve({
        bodies: sizedBodies(row),
        ...(row.configurations!.activeRowId === NARROW && fails()
          ? { failedBodies: new Map([[bodyId, { featureName: 'Bore 3' }]]) }
          : {})
      });
  const narrowFailure = (then: string) =>
    `“Bore 3” failed to rebuild in the configuration “Narrow”, so Plate is not the design there and this sheet would not show it. Fix or suppress the failed feature, or change that configuration’s values, then ${then}.`;

  it('never marks current, exports or keeps a sheet whose pinned row’s feature failed (#2382)', async () => {
    // Wide is active and builds; the view pinned to Narrow draws a row
    // whose third bore fails, so its plate is the bore's unfinished input.
    const sheet = fronts(null, NARROW);
    const first = render(
      sizedWorkspace(sized.document, sheet, {
        requestBodies: boreFailsInNarrow()
      })
    );
    await drawn();
    const svg = screen.getByRole<HTMLButtonElement>('button', {
      name: 'Export SVG'
    });
    await waitFor(() => expect(svg.title).toBe(narrowFailure('export')));
    expect(svg.disabled).toBe(true);
    expect(screen.queryByText('Drawing up to date')).toBeNull();
    expect(screen.getByText(narrowFailure('export'))).toBeTruthy();
    first.unmount();
    // Not kept either: once the model moves on there is no drawing of the
    // failed row to fall back on and export as the earlier design.
    render(
      sizedWorkspace(resized(), sheet, { requestBodies: boreFailsInNarrow() })
    );
    await screen.findByText('Model changed');
    const canvas = screen.getByRole('application', { name: 'Sheet Sheet 1' });
    expect(
      canvas.querySelectorAll('.drawing-view.is-placeholder')
    ).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Export SVG' })).toBeDisabled();
  });

  it('holds the same sheet to nothing once the pinned row builds (#2382)', async () => {
    render(
      sizedWorkspace(sized.document, fronts(null, NARROW), {
        requestBodies: boreFailsInNarrow(() => false)
      })
    );
    await drawn();
    await screen.findByText('Drawing up to date');
    expect(
      screen.getByRole('button', { name: 'Export SVG' })
    ).not.toBeDisabled();
  });

  it('refuses the Update that would fence a sheet to a pinned row’s failed feature (#2382)', async () => {
    const sheet = fronts(null, NARROW);
    const first = render(sizedWorkspace(sized.document, sheet));
    const before = await drawn();
    await waitFor(() => expect(dimension(before, 40)).toBeTruthy());
    first.unmount();
    // Narrow is edited while Wide stays active, and its bore now fails.
    const edit = (value: string) =>
      setConfigurationCell(sized.document, {
        rowId: NARROW,
        column: sized.column,
        value
      });
    let fails = true;
    const onCommand = vi.fn<Props['onCommand']>(() => true);
    const onStatus = vi.fn<Props['onStatus']>();
    const options = {
      onCommand,
      onStatus,
      requestBodies: vi.fn(boreFailsInNarrow(() => fails))
    };
    const view = render(sizedWorkspace(edit('45'), sheet, options));
    await screen.findByText('Model changed');
    // Nothing of the row is built until the Update is asked for.
    expect(options.requestBodies).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Update' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Update' })).toBeNull()
    );
    // The fence is not saved, and the sheet says why.
    expect(onCommand).not.toHaveBeenCalled();
    expect(onStatus).toHaveBeenCalledWith(
      narrowFailure('Update the sheet to export it')
    );
    expect(screen.queryByText('Drawing up to date')).toBeNull();
    // The drawing of the row as it last built still exports, as drawn.
    const kept = svgTexts(await exported('SVG'));
    expect(kept).toContain('40');
    expect(kept).not.toContain('45');
    // Once the row builds, the Update is offered again and saves.
    fails = false;
    view.rerender(sizedWorkspace(edit('46'), sheet, options));
    await userEvent.click(
      await screen.findByRole('button', { name: 'Update' })
    );
    await waitFor(() => expect(onCommand).toHaveBeenCalledTimes(1));
    view.rerender(
      sizedWorkspace(edit('46'), updatedSheet(sheet, onCommand), options)
    );
    const canvas = await drawn();
    await waitFor(() => expect(dimension(canvas, 46)).toBeTruthy());
    await screen.findByText('Drawing up to date');
    // Each row was built once: the Update's check is the build it draws.
    expect(
      options.requestBodies.mock.calls.filter(
        ([row]) => getParameterScope(row).scope.width === 46
      )
    ).toHaveLength(1);
  });

  it('fences a current sheet to the row a view is moved to, in the same step', async () => {
    // One Front on the model's row; it is set to draw Narrow.
    const sheet = fronts(null);
    const onCommand = vi.fn<Props['onCommand']>(() => true);
    const requestBodies = vi.fn((row: ProjectDocument) =>
      Promise.resolve({ bodies: sizedBodies(row) })
    );
    const options = { onCommand, requestBodies };
    const view = render(sizedWorkspace(sized.document, sheet, options));
    const canvas = await drawn(1);
    await waitFor(() => expect(dimension(canvas, 70)).toBeTruthy());
    await userEvent.click(
      within(canvas).getByRole('button', { name: 'Front view' })
    );
    await userEvent.selectOptions(
      screen.getByLabelText('Configuration'),
      NARROW
    );
    // Saved once Narrow has built, not before.
    await waitFor(() => expect(onCommand).toHaveBeenCalledTimes(1));
    // One undoable step: the view's row, and the sheet's fence with it.
    const [edit, rebind] = onCommand.mock.calls
      .at(-1)![0]
      .commands!.map((entry) => entry.payload) as [
      { viewId: DrawingViewId; configurationId: string },
      { source: DrawingSheet['source'] }
    ];
    expect(edit).toMatchObject({
      viewId: sheet.views[0]!.viewId,
      configurationId: NARROW
    });
    const pinned: DrawingSheet = {
      ...sheet,
      source: rebind.source,
      views: [{ ...sheet.views[0]!, configurationId: NARROW }]
    };
    expect(pinned.source.fingerprint).toBe(
      fenced(pinned, sized.document).source.fingerprint
    );
    expect(pinned.source.fingerprint).not.toBe(sheet.source.fingerprint);
    // Still current, and drawn from Narrow.
    view.rerender(sizedWorkspace(sized.document, pinned, options));
    await waitFor(() => expect(dimension(canvas, 40)).toBeTruthy());
    expect(screen.queryByText('Model changed')).toBeNull();
    // Narrow was built once: the check before the fence is the build drawn.
    expect(requestBodies).toHaveBeenCalledTimes(1);
    // An edit to Narrow now leaves it stale, as drawn.
    const edited = setConfigurationCell(sized.document, {
      rowId: NARROW,
      column: sized.column,
      value: '45'
    });
    view.rerender(sizedWorkspace(edited, pinned, options));
    await screen.findByText('Model changed');
    expect(dimension(canvas, 40)).toBeTruthy();
    expect(dimension(canvas, 45)).toBeNull();
  });

  /** `sized` with Narrow's width naming a parameter the model has not got. */
  const narrowUnbuildable = (): ProjectDocument => {
    const set = sized.document.configurations!;
    return {
      ...sized.document,
      configurations: {
        ...set,
        rows: set.rows.map((row) =>
          row.id === NARROW
            ? {
                ...row,
                parameters: {
                  ...row.parameters,
                  [sized.column.parameterId]: 'deleted_name * 2'
                }
              }
            : row
        )
      }
    };
  };
  const narrowUnbuildableReason = (then: string) =>
    new RegExp(
      `^The configuration “Narrow” cannot be built, so this sheet would not show it: .*deleted_name.*\\. Change that configuration’s values, then ${then}\\.$`
    );
  const statusWith = (
    onStatus: { mock: { calls: Parameters<Props['onStatus']>[] } },
    reason: RegExp
  ) => onStatus.mock.calls.some(([message]) => reason.test(message));

  it('refuses the Update that would fence a sheet to a row the model cannot take', async () => {
    const sheet = fronts(null, NARROW);
    const first = render(sizedWorkspace(sized.document, sheet));
    const before = await drawn();
    await waitFor(() => expect(dimension(before, 40)).toBeTruthy());
    first.unmount();
    // Narrow's width now names a parameter the model no longer has, while
    // Wide stays active and builds as it did.
    const onCommand = vi.fn<Props['onCommand']>(() => true);
    const onStatus = vi.fn<Props['onStatus']>();
    const options = { onCommand, onStatus };
    const view = render(sizedWorkspace(narrowUnbuildable(), sheet, options));
    await screen.findByText('Model changed');
    await userEvent.click(screen.getByRole('button', { name: 'Update' }));
    const reason = narrowUnbuildableReason('Update the sheet to export it');
    await waitFor(() => expect(statusWith(onStatus, reason)).toBe(true));
    // No fence is saved: the sheet stays as it was last verified, and its
    // drawing of the row as it last built still exports, as drawn.
    expect(onCommand).not.toHaveBeenCalled();
    expect(screen.queryByText('Drawing up to date')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Update' })).toBeNull();
    expect(svgTexts(await exported('SVG'))).toContain('40');
    // Once the row can be built, the Update is offered again and saves.
    const mended = setConfigurationCell(sized.document, {
      rowId: NARROW,
      column: sized.column,
      value: '46'
    });
    view.rerender(sizedWorkspace(mended, sheet, options));
    await userEvent.click(
      await screen.findByRole('button', { name: 'Update' })
    );
    await waitFor(() => expect(onCommand).toHaveBeenCalledTimes(1));
    updatedSheet(sheet, onCommand);
  });

  it('refuses to move a current view to a row whose feature fails, and keeps the sheet as it is', async () => {
    const sheet = fronts(null);
    const onCommand = vi.fn<Props['onCommand']>(() => true);
    const onStatus = vi.fn<Props['onStatus']>();
    render(
      sizedWorkspace(sized.document, sheet, {
        onCommand,
        onStatus,
        requestBodies: boreFailsInNarrow()
      })
    );
    const canvas = await drawn(1);
    await waitFor(() => expect(dimension(canvas, 70)).toBeTruthy());
    await screen.findByText('Drawing up to date');
    await userEvent.click(
      within(canvas).getByRole('button', { name: 'Front view' })
    );
    await userEvent.selectOptions(
      screen.getByLabelText('Configuration'),
      NARROW
    );
    await waitFor(() =>
      expect(onStatus).toHaveBeenCalledWith(
        narrowFailure('draw the view from it')
      )
    );
    // Neither the view's row nor a fence to its failed build is saved: the
    // sheet is still the verified drawing of the model, and still exports.
    expect(onCommand).not.toHaveBeenCalled();
    expect(screen.getByText('Drawing up to date')).toBeTruthy();
    expect(dimension(canvas, 70)).toBeTruthy();
    expect(svgTexts(await exported('SVG'))).toContain('70');
  });

  it('refuses to move a current view to a row the model cannot take', async () => {
    const sheet = fronts(null);
    const onCommand = vi.fn<Props['onCommand']>(() => true);
    const onStatus = vi.fn<Props['onStatus']>();
    const requestBodies = vi.fn((row: ProjectDocument) =>
      Promise.resolve({ bodies: sizedBodies(row) })
    );
    render(
      sizedWorkspace(narrowUnbuildable(), sheet, {
        onCommand,
        onStatus,
        requestBodies
      })
    );
    const canvas = await drawn(1);
    await screen.findByText('Drawing up to date');
    await userEvent.click(
      within(canvas).getByRole('button', { name: 'Front view' })
    );
    await userEvent.selectOptions(
      screen.getByLabelText('Configuration'),
      NARROW
    );
    const reason = narrowUnbuildableReason('draw the view from it');
    await waitFor(() => expect(statusWith(onStatus, reason)).toBe(true));
    expect(onCommand).not.toHaveBeenCalled();
    expect(requestBodies).not.toHaveBeenCalled();
    expect(screen.getByText('Drawing up to date')).toBeTruthy();
  });

  it('counts a row build that comes in after its sheet left the screen', async () => {
    resetRetainedProjections({ inactiveRowBodiesBytes: 0 });
    // Bare is active; Sheet 1 draws Narrow, Sheet 2 Wide.
    const front = twoFronts().views[0]!;
    const sheetOf = (name: string, row: string): DrawingSheet => {
      const view: DrawingView = {
        ...front,
        viewId: `dview_${row}` as DrawingViewId,
        configurationId: row
      };
      return fenced({
        ...twoFronts(),
        sheetId: `dsht_${row}` as DrawingSheetId,
        name,
        source: { fingerprint: 'v1:any' },
        views: [view],
        annotations: [across(view.viewId, `dann_${row}`)]
      });
    };
    // Narrow's build is slow: it answers only once released.
    let release!: () => void;
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    const requestBodies = vi.fn((row: ProjectDocument) =>
      row.configurations!.activeRowId === NARROW
        ? slow.then(() => ({ bodies: rowBodies(row) }))
        : Promise.resolve({ bodies: rowBodies(row) })
    );
    render(
      workspace(
        {
          ...configured(BARE),
          drawings: {
            sheets: [sheetOf('Sheet 1', NARROW), sheetOf('Sheet 2', WIDE)]
          }
        },
        { requestBodies }
      )
    );
    await waitFor(() => expect(requestBodies).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByRole('tab', { name: 'Sheet 2' }));
    await within(await drawn(1, 'Sheet 2')).findByRole('button', {
      name: 'Horizontal dimension 70'
    });
    // Sheet 1 is off screen when its row's build arrives: over the budget,
    // it is not kept.
    await act(async () => {
      release();
      await slow;
    });
    await waitFor(() => {
      const held = Object.keys(retainedRowBodyIds(project.projectId).cached);
      expect(held).toHaveLength(1);
      expect(held[0]).toContain(WIDE);
    });
  });

  it('lets go of a body once no view of its row draws it', async () => {
    const otherId = 'body_other' as BodyId;
    const build: Build = (document) => {
      const bodies = rowBodies(document);
      return bodies[bodyId]
        ? { ...bodies, [otherId]: { ...plate(30), bodyId: otherId } }
        : bodies;
    };
    // Two views on Narrow: one draws the plate, the other the second body.
    const plateView = twoFronts().views[1]!;
    const otherView: DrawingView = {
      ...plateView,
      viewId: 'dview_other' as DrawingViewId,
      centerMm: { x: 120, y: 150 },
      bodyIds: [otherId]
    };
    const base = twoFronts();
    const sheetOf = (views: DrawingView[]): DrawingSheet =>
      fenced({
        ...base,
        source: { fingerprint: 'v1:any' },
        views,
        annotations: []
      });
    const drawing = (views: DrawingView[]) =>
      workspace(
        { ...configured(WIDE), drawings: { sheets: [sheetOf(views)] } },
        { build }
      );
    const held = () => retainedRowBodyIds(project.projectId);
    const view = render(drawing([plateView, otherView]));
    await drawn(2);
    await waitFor(() =>
      expect(Object.values(held().cached)).toEqual([[otherId, bodyId].sort()])
    );
    // The view of the second body is deleted: its mesh and topology go.
    view.rerender(drawing([plateView]));
    await drawn(1);
    await waitFor(() => {
      expect(Object.values(held().cached)).toEqual([[bodyId]]);
      expect(held().kept.flatMap((kept) => Object.values(kept))).toEqual([
        [bodyId]
      ]);
    });
  });

  it('lists a view whose row does not build its body as not checked', async () => {
    // Wide is active; the sheet's only view draws Bare, which builds no
    // plate: the row is in, and there is nothing in it to check.
    const pinned: DrawingView = {
      ...twoFronts().views[1]!,
      configurationId: BARE
    };
    const sheet = fenced({
      ...twoFronts(),
      source: { fingerprint: 'v1:any' },
      views: [pinned],
      annotations: []
    });
    render(workspace({ ...configured(WIDE), drawings: { sheets: [sheet] } }));
    // Said once the row is in (until then it is "still being built").
    await waitFor(() =>
      expect(
        screen.getByRole('list', { name: 'Views not checked' })
      ).toHaveTextContent('Front: its configuration does not build Plate')
    );
    expect(screen.queryByText(/Every size and position/)).toBeNull();
  });
});
