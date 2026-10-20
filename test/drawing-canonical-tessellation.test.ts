import { afterEach, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  booleanBodies,
  createProjectDocument,
  normalizeDocument,
  listFeaturesInOrder,
  setParameter,
  transformBody,
  updateFeature
} from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import { canonicalDrawingTessellation } from '../packages/kernel-adapter/src/exact-drawing-tessellation';
import {
  toUserId,
  type BodyId,
  type DrawingSheet,
  type ProjectDocument
} from '@openzcad/shared';
import {
  projectView,
  type ProjectionBodyInput
} from '../apps/web/src/lib/drawing/projectView';
import { composeSheetPage } from '../apps/web/src/lib/drawing/sheetPage';
import {
  sheetPageToPdf,
  sheetPageToSvg
} from '../apps/web/src/lib/drawing/sheetExport';
import {
  createStarterSheet,
  drawingSourceFingerprint,
  projectionBodyInput
} from '../apps/web/src/lib/drawing/sheetSources';

type Adapter = Awaited<ReturnType<typeof createExactKernelAdapter>>;
const adapters: Adapter[] = [];

async function freshAdapter(): Promise<Adapter> {
  const adapter = await createExactKernelAdapter();
  adapters.push(adapter);
  return adapter;
}

afterEach(() => {
  for (const adapter of adapters.splice(0)) adapter.dispose();
});

/**
 * An 'r'-radius disc, 4 thick, drilled through off-centre by a Ø10 hole: a
 * rim broad enough for its facets to be set by the chordal deflection (not
 * the angular limit), so a different deflection samples it differently, and
 * a bore that draws hidden lines.
 */
function drilledDisc(radius: number): ProjectDocument {
  let document = createProjectDocument('Disc', toUserId('test'));
  document = setParameter(document, { name: 'r', expression: String(radius) });
  document = addPrimitiveFeature(document, {
    name: 'Disc',
    primitiveKind: 'cylinder',
    dimensions: { radius: 'r', height: 4 }
  });
  const disc = document.bodyOrder.at(-1)!;
  document = addPrimitiveFeature(document, {
    name: 'Drill',
    primitiveKind: 'cylinder',
    dimensions: { radius: 5, height: 10 }
  });
  const drill = document.bodyOrder.at(-1)!;
  document = transformBody(document, {
    name: 'Drill position',
    targetBodyId: drill,
    translation: { x: 8, y: 0, z: -3 }
  }).document;
  return booleanBodies(document, {
    name: 'Drilled disc',
    operation: 'subtract',
    targetBodyIds: [disc, drill]
  }).document;
}

/** Every view hidden-lined, so the page carries dashed runs as well. */
function starter(document: ProjectDocument, bodies: Bodies): DrawingSheet {
  const bodyId = document.bodyOrder.at(-1)!;
  const sheet = createStarterSheet({
    name: 'Sheet 1',
    bodyIds: [bodyId],
    bodies,
    units: document.units,
    paper: { size: 'A3', orientation: 'landscape' },
    projectionAngle: 'first',
    fingerprint: drawingSourceFingerprint(bodies, [bodyId])!
  });
  return {
    ...sheet,
    sheetId: 'dsht_canonical' as DrawingSheet['sheetId'],
    views: sheet.views.map((view, index) => ({
      ...view,
      viewId: `dvw_${index}` as (typeof view)['viewId'],
      parentViewId: view.parentViewId ? ('dvw_0' as const) : undefined,
      hiddenLines: true
    })) as DrawingSheet['views']
  };
}

type Bodies = Awaited<
  ReturnType<Adapter['syncDocument']>
>['bodyRepresentations'];

function exportSheet(
  document: ProjectDocument,
  sheet: DrawingSheet,
  inputs: Record<string, ProjectionBodyInput>
): { pdf: Uint8Array; svg: string } {
  const views = sheet.views.map((view) => ({
    view,
    projection: projectView({
      orientation: view.orientation,
      hiddenLines: view.hiddenLines,
      bodies: [...view.bodyIds].sort().map((id) => inputs[id]!)
    })
  }));
  const page = composeSheetPage(sheet, views, {
    projectName: document.name,
    units: document.units
  });
  return {
    pdf: sheetPageToPdf(page, sheet.name),
    svg: sheetPageToSvg(page, sheet.name)
  };
}

async function canonicalInputs(
  adapter: Adapter,
  document: ProjectDocument,
  bodyIds: BodyId[]
): Promise<Record<string, ProjectionBodyInput>> {
  return adapter.drawingTessellation(document, bodyIds);
}

function displayInputs(
  bodies: Bodies,
  bodyIds: BodyId[]
): Record<string, ProjectionBodyInput> {
  return Object.fromEntries(
    bodyIds.map((id) => [id, projectionBodyInput(bodies[id]!)!])
  );
}

const EDITS: {
  name: string;
  edit: (document: ProjectDocument) => ProjectDocument;
  /** Whether the edit leaves the session's display mesh at a held deflection. */
  heldDeflection: boolean;
}[] = [
  {
    // R20 → R21: the nominal deflection grows 5 %, inside the 25 % band, so
    // the session keeps meshing the disc at the R20 value.
    name: 'a parameter edit inside the held-deflection band',
    edit: (document) => setParameter(document, { name: 'r', expression: '21' }),
    heldDeflection: true
  },
  {
    // Moving the drill replays from the checkpoint before the transform.
    name: 'a checkpoint-replayed edit of the last features',
    edit: (document) => {
      const move = listFeaturesInOrder(document).find(
        (feature) => feature.data.featureKind === 'transform'
      )!;
      if (move.data.featureKind !== 'transform') throw new Error('No move.');
      return updateFeature(document, {
        featureId: move.featureId,
        data: {
          transform: {
            ...move.data.transform,
            translation: { x: 9, y: 0, z: -3 }
          }
        }
      });
    },
    heldDeflection: false
  }
];

describe('D01 canonical drawing tessellation', () => {
  it.each(EDITS)(
    'exports the same PDF and SVG bytes after a cold reload re-meshes the model ($name)',
    async ({ edit, heldDeflection }) => {
      // A session: draw the R20 disc, then edit it.
      const session = await freshAdapter();
      const before = drilledDisc(20);
      expect((await session.syncDocument(before)).warnings).toEqual([]);
      const edited = edit(before);
      const synced = await session.syncDocument(edited);
      expect(synced.warnings).toEqual([]);
      const live = synced.bodyRepresentations;
      const bodyId = edited.bodyOrder.at(-1)!;
      const sheet = starter(edited, live);
      const inSession = exportSheet(
        edited,
        sheet,
        await canonicalInputs(session, edited, [bodyId])
      );

      // A cold reload: the saved document through JSON and a fresh kernel,
      // which rebuilds every feature and meshes at the nominal deflection.
      const reloaded = normalizeDocument(
        JSON.parse(JSON.stringify(edited)) as ProjectDocument
      );
      const cold = await freshAdapter();
      const coldBodies = (await cold.syncDocument(reloaded))
        .bodyRepresentations;
      // The same model as far as the sheet's fence can tell, so the sheet
      // reads ready after the reload…
      expect(drawingSourceFingerprint(coldBodies, [bodyId])).toBe(
        sheet.source.fingerprint
      );
      if (heldDeflection) {
        // …while the display mesh differs, so drawing from it (as D01 did)
        // exports other bytes: the defect this tessellation closes.
        const fromDisplay = exportSheet(
          edited,
          sheet,
          displayInputs(live, [bodyId])
        );
        const coldFromDisplay = exportSheet(
          reloaded,
          sheet,
          displayInputs(coldBodies, [bodyId])
        );
        expect(coldFromDisplay.svg).not.toBe(fromDisplay.svg);
      }

      const afterReload = exportSheet(
        reloaded,
        sheet,
        await canonicalInputs(cold, reloaded, [bodyId])
      );
      expect(afterReload.pdf).toEqual(inSession.pdf);
      expect(afterReload.svg).toBe(inSession.svg);
      // Asked again in the session, after the export build restored the
      // history kernel, the answer is unchanged too.
      expect(
        exportSheet(
          edited,
          sheet,
          await canonicalInputs(session, edited, [bodyId])
        ).svg
      ).toBe(inSession.svg);
    }
  );

  it('refuses a body the model no longer builds', async () => {
    const adapter = await freshAdapter();
    const document = drilledDisc(20);
    const [disc] = document.bodyOrder;
    await expect(
      adapter.drawingTessellation(document, [disc!])
    ).rejects.toThrow(/has no exact geometry to draw/);
  });

  it('canonicalizes the order of faces, triangles, corners, vertices and edges', () => {
    // Two faces of a unit square's top and side, and two edges.
    const top = Float32Array.from([
      0, 0, 1, 1, 0, 1, 1, 1, 1, /* */ 0, 0, 1, 1, 1, 1, 0, 1, 1
    ]);
    const side = Float32Array.from([
      0, 0, 0, 1, 0, 0, 1, 0, 1, /* */ 0, 0, 0, 1, 0, 1, 0, 0, 1
    ]);
    const rim = Float32Array.from([0, 0, 1, 1, 0, 1, 1, 1, 1]);
    const post = Float32Array.from([1, 0, 0, 1, 0, 1]);
    const reference = canonicalDrawingTessellation([top, side], [rim, post]);

    // The same geometry as another build might emit it: faces swapped,
    // triangles swapped and each rotated (winding kept), edges swapped and
    // sampled the other way.
    const rotate = (t: number[]) => [...t.slice(3), ...t.slice(0, 3)];
    const shuffled = (face: Float32Array) => {
      const a = Array.from(face.slice(0, 9));
      const b = Array.from(face.slice(9, 18));
      return Float32Array.from([...rotate(b), ...rotate(rotate(a))]);
    };
    const reversed = (line: Float32Array) => {
      const out: number[] = [];
      for (let i = line.length - 3; i >= 0; i -= 3)
        out.push(line[i]!, line[i + 1]!, line[i + 2]!);
      return Float32Array.from(out);
    };
    const permuted = canonicalDrawingTessellation(
      [shuffled(side), shuffled(top)],
      [reversed(post), reversed(rim)]
    );
    expect(permuted).toEqual(reference);
    // Welded per face: four corners each, two triangles each.
    expect(reference.vertices.length).toBe(2 * 4 * 3);
    expect(reference.faces).toEqual([
      { triangleStart: 0, triangleCount: 2 },
      { triangleStart: 2, triangleCount: 2 }
    ]);
    // Winding survives: every triangle keeps its normal.
    const normal = (mesh: typeof reference, t: number) => {
      const p = (k: number) =>
        Array.from(
          mesh.vertices.slice(
            mesh.indices[t * 3 + k]! * 3,
            mesh.indices[t * 3 + k]! * 3 + 3
          )
        );
      const [a, b, c] = [p(0), p(1), p(2)];
      const u = b.map((v, i) => v - a[i]!);
      const v = c.map((w, i) => w - a[i]!);
      return [
        u[1]! * v[2]! - u[2]! * v[1]!,
        u[2]! * v[0]! - u[0]! * v[2]!,
        u[0]! * v[1]! - u[1]! * v[0]!
      ];
    };
    const normals = [0, 1, 2, 3].map((t) => normal(reference, t));
    expect(normals.filter(([, , z]) => z! > 0)).toHaveLength(2);
    expect(normals.filter(([, y]) => y! < 0)).toHaveLength(2);
  });
});
