import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  addDrawingView,
  assemblyExplodedMatrices,
  assertDocumentContentSchema,
  createProjectDocument,
  DRAWING_EXPLODED_VIEW_SCHEMA_VERSION,
  updateDrawingView
} from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import {
  drawingSetError,
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  solveAssembly,
  toUserId,
  transformToMatrix4,
  type BodyId,
  type BodyRepresentation,
  type DrawingAnnotation,
  type DrawingAnnotationId,
  type DrawingSheet,
  type DrawingSheetId,
  type DrawingView,
  type DrawingViewId,
  type ProjectDocument
} from '@openzcad/shared';
import { projectView } from '../apps/web/src/lib/drawing/projectView';
import {
  explodedSheetFingerprint,
  placedProjectionInput,
  placedSourceBody,
  projectionBodyInput
} from '../apps/web/src/lib/drawing/sheetSources';
import {
  explodedBodyKey,
  resolveSheetAnnotations,
  sheetBom
} from '../apps/web/src/lib/drawing/annotations';
import {
  applyAnnotationPick,
  EXPLODED_VIEW_TOOL_REFUSAL,
  pickableEdges,
  startAnnotationTool
} from '../apps/web/src/lib/drawing/annotationPicking';
import { sectionSourceAt } from '../apps/web/src/lib/drawing/sectionTool';
import { detailSourceAt } from '../apps/web/src/lib/drawing/detailTool';

/**
 * AS03 exploded drawing views (schema v114): a base view, and the views
 * projected from it, draw each assembly part at its solved pose with its
 * stored exploded offset applied, carry notes and balloons only, and fence
 * the sheet to where they place the parts.
 */

type Adapter = Awaited<ReturnType<typeof createExactKernelAdapter>>;
let adapter: Adapter;

beforeAll(async () => {
  adapter = await createExactKernelAdapter();
});
afterAll(() => adapter.dispose());

const sheetId = 'dsht_exploded' as DrawingSheetId;
const frontId = 'dvw_front' as DrawingViewId;
const topId = 'dvw_top' as DrawingViewId;
const id = (name: string) => `dann_${name}` as DrawingAnnotationId;

/** A grounded plate and a free pin, the pin pulled out 100 mm along X. */
async function rig(offset = { x: 100, y: 0, z: 0 }) {
  const manager = new CommandManager(
    createProjectDocument('Exploded drawing', toUserId('test'))
  );
  manager.execute(
    commandFactories.addPrimitive({
      name: 'Plate',
      primitiveKind: 'box',
      dimensions: { width: 40, height: 10, depth: 20 }
    })
  );
  manager.execute(
    commandFactories.addPrimitive({
      name: 'Pin',
      primitiveKind: 'cylinder',
      dimensions: { radius: 3, height: 12 }
    })
  );
  const [plate, pin] = manager.document.bodyOrder as [BodyId, BodyId];
  manager.execute(
    commandFactories.addAssemblyComponents({
      components: [
        {
          componentId: 'c_plate',
          name: 'Plate',
          bodyId: plate,
          grounded: true
        },
        { componentId: 'c_pin', name: 'Pin', bodyId: pin, grounded: false }
      ]
    })
  );
  manager.execute(
    commandFactories.setAssemblyExplode({ offsets: { c_pin: offset } })
  );
  let document = manager.document;
  const derived = await adapter.syncDocument(document);
  document = {
    ...document,
    derived: {
      ...document.derived,
      bodyRepresentations: derived.bodyRepresentations
    }
  };
  return {
    manager,
    document,
    bodies: derived.bodyRepresentations as Record<string, BodyRepresentation>,
    plate,
    pin
  };
}

function view(
  viewId: DrawingViewId,
  bodyIds: BodyId[],
  extra: Partial<DrawingView> = {}
): DrawingView {
  return {
    viewId,
    orientation: 'front',
    bodyIds,
    centerMm: { x: 150, y: 150 },
    hiddenLines: false,
    ...extra
  };
}

function sheetOf(
  views: DrawingView[],
  annotations: DrawingAnnotation[] = []
): DrawingSheet {
  return {
    sheetId,
    name: 'Sheet 1',
    paper: { size: 'A3', orientation: 'landscape' },
    scale: { numerator: 1, denominator: 1 },
    projectionAngle: 'third',
    titleBlock: {},
    source: { fingerprint: 'v1:test' },
    views,
    ...(annotations.length > 0 ? { annotations } : {})
  };
}

const withSheet = (document: ProjectDocument, sheet: DrawingSheet) => ({
  ...document,
  drawings: { sheets: [sheet] }
});

describe('exploded drawing views (AS03, schema v114)', () => {
  it('claims v114 and validates where a view may be drawn exploded', () => {
    expect(PROJECT_DOCUMENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(
      DRAWING_EXPLODED_VIEW_SCHEMA_VERSION
    );
    const b = ['b' as BodyId];
    const check = (views: DrawingView[], annotations: unknown[] = []) =>
      drawingSetError({
        sheets: [sheetOf(views, annotations as DrawingAnnotation[])]
      });
    const base = view(frontId, b, { exploded: true });
    const top = view(topId, b, {
      orientation: 'top',
      centerMm: { x: 150, y: 250 },
      parentViewId: frontId,
      exploded: true
    });
    expect(check([base, top])).toBeNull();
    const detail = view('dvw_detail' as DrawingViewId, b, {
      centerMm: { x: 300, y: 150 },
      detail: {
        sourceViewId: frontId,
        label: 'A',
        center: { u: 0, v: 0 },
        radius: 5,
        scale: { numerator: 2, denominator: 1 }
      }
    });
    const note = {
      annotationId: id('note'),
      kind: 'note',
      text: 'PULL OUT',
      viewId: frontId,
      placementMm: { x: 10, y: 10 }
    };
    const linear = {
      annotationId: id('lin'),
      kind: 'linear',
      viewId: frontId,
      direction: 'horizontal',
      from: { edge: { bodyId: 'b', hash: 1 }, anchor: 'first' },
      to: { edge: { bodyId: 'b', hash: 1 }, anchor: 'second' },
      placementMm: { x: 0, y: 20 }
    };
    expect(check([base], [note])).toBeNull();
    const bad: [DrawingView[], unknown[], RegExp][] = [
      [
        [{ ...base, exploded: false as unknown as true }],
        [],
        /invalid exploded setting/
      ],
      [
        [base, { ...top, exploded: undefined }],
        [],
        /not drawn exploded the way its base is/
      ],
      [
        [{ ...base, exploded: undefined }, top],
        [],
        /not drawn exploded the way its base is/
      ],
      [[base, detail], [], /taken from an exploded view/],
      [
        [view(frontId, b), { ...detail, exploded: true }],
        [],
        /only a base view and the views projected from it/
      ],
      [
        [{ ...base, configurationId: 'row_a' }],
        [],
        /draws another configuration and cannot be drawn exploded/
      ],
      [
        [base],
        [linear],
        /linear on an exploded view, which carries notes and balloons only/
      ]
    ];
    for (const [views, annotations, message] of bad)
      expect(check(views, annotations)).toMatch(message);
  });

  it('explodes a base view with its projected views in one undoable command, and refuses what it cannot draw', async () => {
    const { manager, plate, pin } = await rig();
    const sheet = sheetOf([
      view(frontId, [plate, pin]),
      view(topId, [plate, pin], {
        orientation: 'top',
        centerMm: { x: 150, y: 250 },
        parentViewId: frontId
      })
    ]);
    manager.execute(commandFactories.addDrawingSheet({ sheet }));
    manager.execute(
      commandFactories.updateDrawingView({
        sheetId,
        viewId: frontId,
        exploded: true,
        source: { fingerprint: 'v1:test|x:0123456789abcdef' }
      })
    );
    const exploded = manager.document.drawings!.sheets[0]!;
    expect(exploded.views.map((entry) => entry.exploded)).toEqual([true, true]);
    expect(exploded.source.fingerprint).toBe('v1:test|x:0123456789abcdef');
    expect(() => assertDocumentContentSchema(manager.document)).not.toThrow();
    // An older document cannot hold one.
    expect(() =>
      assertDocumentContentSchema({
        ...manager.document,
        schemaVersion: (DRAWING_EXPLODED_VIEW_SCHEMA_VERSION -
          1) as typeof PROJECT_DOCUMENT_SCHEMA_VERSION
      })
    ).toThrow(
      `Exploded drawing views require project schema v${DRAWING_EXPLODED_VIEW_SCHEMA_VERSION}`
    );
    // A view projected later from it draws exploded too.
    const right = addDrawingView(manager.document, {
      sheetId,
      view: view('dvw_right' as DrawingViewId, [plate, pin], {
        orientation: 'right',
        centerMm: { x: 260, y: 150 },
        parentViewId: frontId
      })
    }).drawings!.sheets[0]!.views.at(-1)!;
    expect(right.exploded).toBe(true);
    // Refused: on a projected view, a rebind alone, and dimensions present.
    expect(() =>
      updateDrawingView(manager.document, {
        sheetId,
        viewId: topId,
        exploded: false
      })
    ).toThrow(/choose it there/);
    expect(() =>
      updateDrawingView(manager.document, {
        sheetId,
        viewId: frontId,
        source: { fingerprint: 'v1:other' }
      })
    ).toThrow(/only when exploding it/);
    manager.undo();
    expect(
      manager.document.drawings!.sheets[0]!.views.map((entry) => entry.exploded)
    ).toEqual([undefined, undefined]);
    expect(manager.document.drawings!.sheets[0]!.source.fingerprint).toBe(
      'v1:test'
    );
    const dimensioned = withSheet(
      manager.document,
      sheetOf(
        [view(frontId, [plate, pin])],
        [
          {
            annotationId: id('dia'),
            kind: 'diameter',
            viewId: frontId,
            edge: { bodyId: pin, hash: 7 },
            placementMm: { x: 10, y: 10 }
          }
        ]
      )
    );
    expect(() =>
      updateDrawingView(dimensioned, {
        sheetId,
        viewId: frontId,
        exploded: true
      })
    ).toThrow(/notes and balloons only/);
  });

  it('places each part at its solved pose with its offset applied after it', async () => {
    const { manager } = await rig({ x: 0, y: 0, z: 25 });
    // Turn the pin on a hinge, so the pose is not the identity.
    manager.execute(
      commandFactories.addAssemblyJoint({
        joint: {
          id: 'j_pin',
          name: 'Hinge',
          kind: 'revolute',
          parent: {
            componentId: 'c_plate',
            frame: {
              origin: { x: 0, y: 0, z: 0 },
              zAxis: { x: 0, y: 0, z: 1 },
              xAxis: { x: 1, y: 0, z: 0 }
            }
          },
          child: {
            componentId: 'c_pin',
            frame: {
              origin: { x: 10, y: 0, z: 0 },
              zAxis: { x: 0, y: 0, z: 1 },
              xAxis: { x: 1, y: 0, z: 0 }
            }
          },
          values: [30],
          limits: [null]
        }
      })
    );
    const document = manager.document;
    const [plate, pin] = document.bodyOrder as [BodyId, BodyId];
    const matrices = assemblyExplodedMatrices(document, () => true);
    const pose = solveAssembly(document.assembly!).poses.get('c_pin')!;
    const expected = transformToMatrix4({
      t: { x: pose.t.x, y: pose.t.y, z: pose.t.z + 25 },
      q: pose.q
    });
    expect(matrices.get(pin)).toEqual(expected);
    expect(matrices.get(plate)).toEqual(
      transformToMatrix4(
        solveAssembly(document.assembly!).poses.get('c_plate')!
      )
    );
    // A body in no part is drawn where it was modelled.
    expect(
      assemblyExplodedMatrices({ ...document, assembly: undefined })
    ).toEqual(new Map());
  });

  it('draws the pulled-out pin where Assemble shows it and balloons it there', async () => {
    const { document, bodies, plate, pin } = await rig();
    const matrices = assemblyExplodedMatrices(document);
    const pinMatrix = matrices.get(pin)!;
    const pinInput = projectionBodyInput(bodies[pin]!)!;
    const project = (inputs: ReturnType<typeof projectionBodyInput>[]) =>
      projectView({
        orientation: 'front',
        hiddenLines: false,
        bodies: inputs.map((input) => input!)
      }).bounds!;
    const modelled = project([pinInput]);
    const placed = project([placedProjectionInput(pinInput, pinMatrix)]);
    // Front view: u is world X, v is world Z.
    expect(placed.minU - modelled.minU).toBeCloseTo(100, 6);
    expect(placed.maxU - modelled.maxU).toBeCloseTo(100, 6);
    expect(placed.minV).toBeCloseTo(modelled.minV, 6);
    expect(placed.maxV).toBeCloseTo(modelled.maxV, 6);

    // A balloon on the exploded view points at the pin where it is drawn.
    const edge = bodies[pin]!.topology!.edges.find(
      (entry) => entry.curve?.circle
    )!;
    const balloon: DrawingAnnotation = {
      annotationId: id('pin'),
      kind: 'balloon',
      viewId: frontId,
      leader: { bodyId: pin, hash: edge.hash },
      componentId: 'c_pin',
      placementMm: { x: 60, y: 30 }
    };
    const sheet = sheetOf(
      [view(frontId, [plate, pin], { exploded: true })],
      [balloon]
    );
    expect(drawingSetError({ sheets: [sheet] })).toBeNull();
    const measured: Record<string, BodyRepresentation> = {
      ...bodies,
      [explodedBodyKey(frontId, pin)]: placedSourceBody(
        bodies[pin]!,
        pinMatrix
      ),
      [explodedBodyKey(frontId, plate)]: placedSourceBody(
        bodies[plate]!,
        matrices.get(plate)!
      )
    };
    const leaderU = (
      source: Record<string, BodyRepresentation>,
      exploded: boolean
    ) => {
      const resolutions = resolveSheetAnnotations(
        exploded ? sheet : sheetOf([view(frontId, [plate, pin])], [balloon]),
        source,
        'mm',
        undefined,
        sheetBom(document)
      );
      const resolution = resolutions.get(id('pin'))!;
      expect(resolution.ok).toBe(true);
      if (!resolution.ok || resolution.resolved.kind !== 'balloon')
        throw new Error('unresolved');
      expect(resolution.resolved.label).toBe('2');
      const leader = resolution.resolved.leader;
      return Math.min(...leader.filter((_, index) => index % 2 === 0));
    };
    expect(leaderU(measured, true) - leaderU(bodies, false)).toBeCloseTo(
      100,
      6
    );
    // Picking: the exploded view offers the placed edge to a balloon, and
    // refuses a dimension tool with the reason.
    const views = [
      {
        view: sheet.views[0]!,
        projection: projectView({
          orientation: 'front',
          hiddenLines: false,
          bodies: [
            placedProjectionInput(
              projectionBodyInput(bodies[plate]!)!,
              matrices.get(plate)!
            ),
            placedProjectionInput(pinInput, pinMatrix)
          ]
        })
      }
    ];
    const edges = pickableEdges(sheet, views, measured, 'mm');
    const hit = edges.find((entry) => entry.bodyId === pin)!;
    expect(hit).toBeDefined();
    const refused = applyAnnotationPick(
      startAnnotationTool('diameter'),
      hit,
      hit.page[0]!,
      sheet.views[0]!,
      measured
    );
    expect(refused).toEqual({ ok: false, message: EXPLODED_VIEW_TOOL_REFUSAL });
    expect(
      applyAnnotationPick(
        startAnnotationTool('balloon'),
        hit,
        hit.page[0]!,
        sheet.views[0]!,
        measured
      ).ok
    ).toBe(true);
    // Sections and details are not taken from it.
    const inside: [number, number] = [150, 150];
    expect(sectionSourceAt(sheet, views, inside, 'mm')).toBeNull();
    expect(detailSourceAt(sheet, views, inside, 'mm')).toBeNull();
  });

  it('fences a sheet to where its exploded views place the parts', async () => {
    const { document, plate, pin } = await rig();
    const exploded = sheetOf([view(frontId, [plate, pin], { exploded: true })]);
    const assembled = sheetOf([view(frontId, [plate, pin])]);
    const at = (doc: ProjectDocument) => assemblyExplodedMatrices(doc);
    const fence = explodedSheetFingerprint('v1:base', exploded, at(document));
    expect(fence).toMatch(/^v1:base\|x:[0-9a-f]{16}$/);
    // Unchanged by a sheet with nothing exploded, and stable.
    expect(explodedSheetFingerprint('v1:base', assembled, at(document))).toBe(
      'v1:base'
    );
    expect(explodedSheetFingerprint('v1:base', exploded, at(document))).toBe(
      fence
    );
    // A part pulled out further moves the fence.
    const further = {
      ...document,
      assembly: {
        ...document.assembly!,
        explode: { offsets: { c_pin: { x: 120, y: 0, z: 0 } } }
      }
    };
    expect(explodedSheetFingerprint('v1:base', exploded, at(further))).not.toBe(
      fence
    );
  });
});
