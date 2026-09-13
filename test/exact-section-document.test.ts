import { afterAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  booleanBodies,
  createProjectDocument,
  transformBody
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import type { ProjectDocument, UnitSystem } from '@openzcad/shared';
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
