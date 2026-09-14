import { afterAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  booleanBodies,
  createProjectDocument,
  importStepBody,
  transformBody
} from '@openzcad/document-core';
import { toBodyId, toUserId } from '@openzcad/shared';
import type { BodyId, ProjectDocument, UnitSystem } from '@openzcad/shared';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';

/**
 * The document-level exact section: what the app asks for when the section
 * slider is released, and what it writes when someone exports the cut.
 */

let adapter: ExactKernelAdapter | null = null;

afterAll(() => {
  adapter?.dispose();
  adapter = null;
});

async function kernel(): Promise<ExactKernelAdapter> {
  adapter ??= await createExactKernelAdapter();
  return adapter;
}

/**
 * A 20 x 10 x 6 bar with a 4-unit bore through its thickness at (10, 5).
 * A box primitive's `depth` is its vertical extent, not its `height`.
 */
function boredBar(units: UnitSystem = 'mm'): ProjectDocument {
  let doc = createProjectDocument('Section', toUserId('user_section'), units);
  doc = addPrimitiveFeature(doc, {
    name: 'bar',
    primitiveKind: 'box',
    dimensions: { width: 20, height: 10, depth: 6 }
  });
  doc = addPrimitiveFeature(doc, {
    name: 'bore',
    primitiveKind: 'cylinder',
    dimensions: { radius: 2, height: 20 }
  });
  const barId = doc.bodyOrder[0]!;
  const boreId = doc.bodyOrder.at(-1)!;
  doc = transformBody(doc, {
    name: 'Place bore',
    targetBodyId: boreId,
    translation: { x: 10, y: 5, z: -5 }
  }).document;
  return booleanBodies(doc, {
    name: 'Bore',
    operation: 'subtract',
    targetBodyIds: [barId, boreId]
  }).document;
}

/**
 * Two separate bars, 20 x 10 x 6 and 8 x 4 x 6, both standing on z = 0 so a
 * plane at z = 3 cuts each of them. Bodies are corner-origin, so the second
 * clears the first by translating in x alone.
 */
function twoBars(): {
  document: ProjectDocument;
  first: BodyId;
  second: BodyId;
} {
  let doc = createProjectDocument('Two bars', toUserId('user_section'));
  doc = addPrimitiveFeature(doc, {
    name: 'left',
    primitiveKind: 'box',
    dimensions: { width: 20, height: 10, depth: 6 }
  });
  const first = doc.bodyOrder.at(-1)!;
  doc = addPrimitiveFeature(doc, {
    name: 'right',
    primitiveKind: 'box',
    dimensions: { width: 8, height: 4, depth: 6 }
  });
  const second = doc.bodyOrder.at(-1)!;
  doc = transformBody(doc, {
    name: 'Place right',
    targetBodyId: second,
    translation: { x: 40, y: 0, z: 0 }
  }).document;
  return { document: doc, first, second };
}

/**
 * ONE body holding TWO disjoint solids, written and re-imported through the
 * adapter's own STEP path because that is the only way a model gets one: a
 * 10-cube on the origin and a 6-cube lifted clear of it. A plane at z = 5
 * cuts the first solid and misses the second, so the kernel — which answers
 * per solid — reports a region and a refusal for the same body.
 */
async function twoSolidBody(exact: ExactKernelAdapter): Promise<{
  document: ProjectDocument;
  bodyId: BodyId;
}> {
  let source = createProjectDocument('Two solids', toUserId('user_section'));
  source = addPrimitiveFeature(source, {
    name: 'Low',
    primitiveKind: 'box',
    dimensions: { width: 10, height: 10, depth: 10 }
  });
  source = addPrimitiveFeature(source, {
    name: 'High',
    primitiveKind: 'box',
    dimensions: { width: 6, height: 6, depth: 6 }
  });
  const high = source.bodyOrder.at(-1)!;
  source = transformBody(source, {
    name: 'Lift',
    targetBodyId: high,
    translation: { x: 40, y: 0, z: 40 }
  }).document;
  const stepText = await exact.exportStep(source, source.bodyOrder);
  const imported = importStepBody(
    createProjectDocument('Imported', toUserId('user_section')),
    {
      name: 'Imported',
      artifactId: 'artifact_two_solids',
      sourceName: 'two-solids.step',
      stepText
    }
  );
  return { document: imported.document, bodyId: imported.bodyId };
}

const XY_AT_3 = { origin: [0, 0, 3], normal: [0, 0, 1] } as const;

/** DXF is a flat stream of [group code, value] line pairs. */
function groups(text: string): Array<[number, string]> {
  const lines = text.split('\r\n').filter((line) => line.length > 0);
  const pairs: Array<[number, string]> = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    pairs.push([Number(lines[i]), lines[i + 1]!]);
  }
  return pairs;
}

/** Every value carried by one group code, as a number. */
function values(text: string, code: number): number[] {
  return groups(text)
    .filter(([group]) => group === code)
    .map(([, value]) => Number(value));
}

function extent(text: string, code: number): number {
  const found = values(text, code);
  return Math.max(...found) - Math.min(...found);
}

describe('sectionOutline', () => {
  it('returns the cut region with its bore, in document space', async () => {
    const exact = await kernel();
    const report = await exact.sectionOutline(boredBar(), XY_AT_3);
    expect(report.refusals).toEqual([]);
    expect(report.regions).toHaveLength(1);
    const region = report.regions[0]!;
    expect(region.area).toBeGreaterThan(180);
    expect(region.area).toBeLessThan(200);
    expect(region.loops.map((loop) => loop.kind)).toEqual(['outer', 'inner']);
    for (const loop of region.loops) {
      for (const point of loop.points) {
        expect(point[2]).toBeCloseTo(3, 9);
      }
    }
    expect(region.indices.length).toBeGreaterThanOrEqual(3);
  }, 120_000);

  it('sections only the bodies it is given', async () => {
    const exact = await kernel();
    const { document, first, second } = twoBars();

    const both = await exact.sectionOutline(document, XY_AT_3);
    expect(both.regions.map((region) => region.bodyId).sort()).toEqual(
      [first, second].sort()
    );

    // Hiding or isolating a body is device-local view state the document
    // never carries. Asked without a list, the adapter sections both bars —
    // so the app has to name the ones its viewport is showing, or a hidden
    // body's cut is drawn floating in empty space and its area counted in.
    const named = await exact.sectionOutline(document, XY_AT_3, [first]);
    expect(named.regions).toHaveLength(1);
    expect(named.regions[0]!.bodyId).toBe(first);
    expect(named.regions[0]!.area).toBeCloseTo(200, 3);
    expect(named.refusals).toEqual([]);
  }, 120_000);

  it('refuses a body this document has no geometry for, keeping the rest', async () => {
    const exact = await kernel();
    const { document, first } = twoBars();

    // The mismatch this guards: the viewport is showing a PREVIEW
    // document's bodies while the live document is the one being sectioned,
    // so the list names a body the live build never made. Thrown, it took
    // the whole section with it and put a raw internal message on the rail;
    // refused by name, every body that does cut is still drawn and measured.
    const report = await exact.sectionOutline(document, XY_AT_3, [
      first,
      toBodyId('body_preview_only')
    ]);
    expect(report.regions).toHaveLength(1);
    expect(report.regions[0]!.bodyId).toBe(first);
    expect(report.regions[0]!.area).toBeCloseTo(200, 3);
    expect(report.refusals).toEqual([
      {
        bodyId: 'body_preview_only',
        reason: 'unknown-body',
        message: 'Body body_preview_only has no exact geometry in this model.'
      }
    ]);
  }, 120_000);

  it('sections a preview document by ITS bodies, which the live one lacks', async () => {
    const exact = await kernel();
    const { document: live, first } = twoBars();
    // What a form preview publishes: the live document plus the command's
    // result, never written back. The viewport draws THIS document's bodies
    // while `doc` is still the one above.
    const preview = addPrimitiveFeature(live, {
      name: 'preview',
      primitiveKind: 'box',
      dimensions: { width: 4, height: 4, depth: 6 }
    });
    const previewOnly = preview.bodyOrder.at(-1)!;
    expect(live.bodyOrder).not.toContain(previewOnly);
    const visible = [first, previewOnly];

    // Asked of the document the bodies came from, both cut.
    const shown = await exact.sectionOutline(preview, XY_AT_3, visible);
    expect(shown.refusals).toEqual([]);
    expect(shown.regions.map((region) => region.bodyId).sort()).toEqual(
      [...visible].sort()
    );
    expect(
      shown.regions.reduce((total, region) => total + region.area, 0)
    ).toBeCloseTo(200 + 16, 3);

    // Asked of the LIVE one, the preview body is refused by name — and the
    // bar is still sectioned, drawn and measured. Thrown, this took the
    // whole section down and put the throw's text on the rail instead.
    const stale = await exact.sectionOutline(live, XY_AT_3, visible);
    expect(stale.regions).toHaveLength(1);
    expect(stale.regions[0]!.bodyId).toBe(first);
    expect(stale.refusals.map((refusal) => refusal.reason)).toEqual([
      'unknown-body'
    ]);
  }, 180_000);

  it('answers per solid for a body that holds several', async () => {
    const exact = await kernel();
    const { document, bodyId } = await twoSolidBody(exact);
    const report = await exact.sectionOutline(document, {
      origin: [0, 0, 5],
      normal: [0, 0, 1]
    });
    // One body, two solids, one of them cut: a region and a refusal both
    // carrying the SAME body id. Anything counting refusals as bodies then
    // tells the user this body is not cut while drawing its cross-section.
    expect(report.regions).toHaveLength(1);
    expect(report.regions[0]!.bodyId).toBe(bodyId);
    expect(report.regions[0]!.area).toBeCloseTo(100, 3);
    expect(report.refusals).toEqual([
      {
        bodyId,
        reason: 'plane-misses-body',
        message: 'The section plane does not pass through this body.'
      }
    ]);
  }, 180_000);

  it('reports a plane that misses the body as a refusal, not a failure', async () => {
    const exact = await kernel();
    const report = await exact.sectionOutline(boredBar(), {
      origin: [0, 0, 40],
      normal: [0, 0, 1]
    });
    expect(report.regions).toEqual([]);
    expect(report.refusals).toHaveLength(1);
    expect(report.refusals[0]!.reason).toBe('plane-misses-body');
  }, 120_000);
});

describe('exportSectionDxf', () => {
  it('writes the cut outline in millimetres with the unit header', async () => {
    const exact = await kernel();
    const text = await exact.exportSectionDxf(boredBar(), XY_AT_3);
    const pairs = groups(text);
    expect(pairs[0]).toEqual([0, 'SECTION']);
    expect(pairs[1]).toEqual([2, 'HEADER']);
    expect(pairs).toContainEqual([1, 'AC1009']);
    const unitsAt = pairs.findIndex(([, value]) => value === '$INSUNITS');
    expect(unitsAt).toBeGreaterThan(0);
    // 4 is millimetres, and the drawing carries no other unit claim.
    expect(pairs[unitsAt + 1]).toEqual([70, '4']);
    expect(pairs.at(-1)).toEqual([0, 'EOF']);

    // Group 10 and 20 are entity x and y: the bar is 20 mm by 10 mm.
    expect(extent(text, 10)).toBeCloseTo(20, 6);
    expect(extent(text, 20)).toBeCloseTo(10, 6);
  }, 120_000);

  it('scales an inch document into millimetres', async () => {
    const exact = await kernel();
    const text = await exact.exportSectionDxf(boredBar('inch'), XY_AT_3);
    // The document is 20 inches across; the drawing is 508 mm across.
    expect(extent(text, 10)).toBeCloseTo(20 * 25.4, 4);
    expect(extent(text, 20)).toBeCloseTo(10 * 25.4, 4);
  }, 120_000);

  it('draws only the bodies it is given', async () => {
    const exact = await kernel();
    const { document, second } = twoBars();
    const text = await exact.exportSectionDxf(document, XY_AT_3, [second]);
    // The small bar alone: 8 mm by 4 mm, with nothing of the 20 mm one.
    expect(extent(text, 10)).toBeCloseTo(8, 6);
    expect(extent(text, 20)).toBeCloseTo(4, 6);
  }, 120_000);

  it('refuses a drawing that would silently lose a named body', async () => {
    const exact = await kernel();
    const { document, first } = twoBars();
    // `sectionOutline` refuses this body by name and draws the rest; a
    // DRAWING may not quietly lose it, so the export fails closed. The rail's
    // export gate is shut in that state, which is what keeps a user from
    // ever seeing this message.
    await expect(
      exact.exportSectionDxf(document, XY_AT_3, [
        first,
        toBodyId('body_preview_only')
      ])
    ).rejects.toThrow(/body_preview_only has no exact geometry in this model/);
  }, 120_000);

  it('refuses to write a drawing for a plane that cuts nothing', async () => {
    const exact = await kernel();
    await expect(
      exact.exportSectionDxf(boredBar(), { origin: [0, 0, 40], normal: [0, 0, 1] })
    ).rejects.toThrow(/does not cut any body/);
  }, 120_000);

  it('refuses to write a drawing the kernel cannot section correctly', async () => {
    const exact = await kernel();
    // Down the bore axis, where the kernel drops the bore from its outline.
    await expect(
      exact.exportSectionDxf(boredBar(), { origin: [0, 5, 0], normal: [0, 1, 0] })
    ).rejects.toThrow(/tessellated witness/);
  }, 120_000);
});
