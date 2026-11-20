import { beforeAll, describe, expect, it } from 'vitest';

import {
  addPrimitiveFeature,
  createProjectDocument,
  holeBody
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  cncEntityBounds,
  cncHeightLayer,
  cncLabel
} from '../packages/kernel-adapter/src/exact-cnc-layout';
import { importDxfSketch } from '../apps/web/src/lib/dxfImport';
import { dxfTextLength } from '@openzcad/io-dxf';
import { parseCadPatchProposal } from '@openzcad/ai-contracts';
import {
  CommandManager,
  commandsForCadPatch,
  composeCommands
} from '@openzcad/command-system';
import { toUserId } from '@openzcad/shared';
import type { BodyId, ProjectDocument } from '@openzcad/shared';

/**
 * L09: the CNC-cut layout on real kernel bodies. Parts are laid on their
 * largest flat face; every face looking straight up is cut on the layer of
 * its height; parts sit apart in rows with their names on LABELS.
 */

let adapter: ExactKernelAdapter;

beforeAll(async () => {
  adapter = await createExactKernelAdapter();
});

interface Entity {
  type: string;
  layer: string;
  groups: Map<number, string[]>;
}

function entities(text: string): Entity[] {
  const lines = text.split('\r\n');
  const pairs: Array<[number, string]> = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    pairs.push([Number(lines[i]), lines[i + 1]!]);
  }
  const start = pairs.findIndex(([c, v]) => c === 2 && v === 'ENTITIES');
  const out: Entity[] = [];
  let current: Entity | undefined;
  for (const [code, value] of pairs.slice(start + 1)) {
    if (code === 0) {
      if (value === 'ENDSEC' || value === 'EOF') break;
      current = { type: value, layer: '0', groups: new Map() };
      out.push(current);
      continue;
    }
    if (!current) continue;
    if (code === 8) current.layer = value;
    const bucket = current.groups.get(code) ?? [];
    bucket.push(value);
    current.groups.set(code, bucket);
  }
  return out;
}

const num = (entity: Entity, code: number): number =>
  Number(entity.groups.get(code)![0]);

function layerNames(text: string): string[] {
  const lines = text.split('\r\n');
  const names: string[] = [];
  for (let i = 0; i + 3 < lines.length; i += 2) {
    if (lines[i] === '0' && lines[i + 1] === 'LAYER' && lines[i + 2] === '2') {
      names.push(lines[i + 3]!);
    }
  }
  return names;
}

/**
 * A 40 × 24 × 10 plate (the box primitive's height runs along Y, so its
 * two largest faces look along ±Y) with a 6 mm through hole counterbored
 * 11 mm × 3 mm deep from +Y, a Ø12 × 4 puck and a ball.
 */
async function shopDocument(): Promise<{
  document: ProjectDocument;
  plate: BodyId;
  puck: BodyId;
  ball: BodyId;
}> {
  let document = addPrimitiveFeature(
    createProjectDocument('CNC parts', toUserId('user_cnc')),
    {
      name: 'Plate',
      primitiveKind: 'box',
      dimensions: { width: 40, depth: 24, height: 10 }
    }
  );
  const blank = document.bodyOrder[0]!;
  const derived = await adapter.syncDocument(document);
  const face = derived.bodyRepresentations[blank]!.topology!.faces.find(
    (f) =>
      f.geometry?.surfaceType === 'plane' &&
      f.geometry.normal !== undefined &&
      Math.abs(f.geometry.normal.y - 1) < 1e-9
  )!;
  const drilled = holeBody(document, {
    name: 'Bolt hole',
    targetBodyId: blank,
    faceHash: face.hash,
    ...(face.reference ? { faceReference: face.reference } : {}),
    style: 'counterbore',
    diameter: 6,
    counterboreDiameter: 11,
    counterboreDepth: 3,
    depthMode: 'through',
    position: { u: 0, v: 0 }
  });
  document = addPrimitiveFeature(drilled.document, {
    name: 'Puck',
    primitiveKind: 'cylinder',
    dimensions: { radius: 6, height: 4 }
  });
  const puck = document.bodyOrder.at(-1)!;
  document = addPrimitiveFeature(document, {
    name: 'Ball',
    primitiveKind: 'sphere',
    dimensions: { radius: 5 }
  });
  const ball = document.bodyOrder.at(-1)!;
  const built = await adapter.syncDocument(document);
  expect(built.warnings).toEqual([]);
  return { document, plate: drilled.bodyId, puck, ball };
}

describe('CNC-cut layout export', () => {
  it('lays each part flat and cuts every upward face on its height layer', async () => {
    const { document, plate, puck, ball } = await shopDocument();
    const result = await adapter.exportCncLayoutDxf(document, [
      plate,
      puck,
      ball
    ]);

    // The ball has no flat face: refused by name, the rest still laid out.
    expect(result.refused).toEqual([
      { bodyId: ball, name: 'Ball Body', reason: 'no-flat-face' }
    ]);
    expect(result.warnings).toEqual([
      'Ball Body has no flat face to lay it on'
    ]);
    expect(result.placements.map((p) => p.name)).toEqual([
      'Plate Body',
      'Puck Body'
    ]);

    const [platePlaced, puckPlaced] = result.placements;
    // The plate rests on its uncut side: the counterbored side faces up,
    // at 10, and the counterbore's floor at 10 − 3.
    expect(platePlaced!.faceHeights).toEqual([7, 10]);
    expect(
      [platePlaced!.width, platePlaced!.height].sort((a, b) => a - b)
    ).toEqual([24, 40]);
    expect(puckPlaced!.faceHeights).toEqual([4]);
    expect(puckPlaced!.width).toBeCloseTo(12, 9);

    const all = entities(result.text);
    const plateTop = all.filter((e) => e.layer === 'Z10');
    expect(plateTop.map((e) => e.type).sort()).toEqual([
      'CIRCLE',
      'LINE',
      'LINE',
      'LINE',
      'LINE'
    ]);
    expect(
      num(
        plateTop.find((e) => e.type === 'CIRCLE')!,
        40
      )
    ).toBeCloseTo(5.5, 9);
    // The counterbore floor: an annulus between the bore and the hole.
    const floor = all.filter((e) => e.layer === 'Z7');
    expect(floor.map((e) => num(e, 40)).sort((a, b) => a - b)).toEqual([
      3, 5.5
    ]);
    // Concentric with the counterbore on top, as the part is.
    const topCircle = plateTop.find((e) => e.type === 'CIRCLE')!;
    for (const circle of floor) {
      expect(num(circle, 10)).toBeCloseTo(num(topCircle, 10), 9);
      expect(num(circle, 20)).toBeCloseTo(num(topCircle, 20), 9);
    }
    const puckTop = all.filter((e) => e.layer === 'Z4');
    expect(puckTop).toHaveLength(1);
    expect(puckTop[0]!.type).toBe('CIRCLE');
    expect(num(puckTop[0]!, 40)).toBeCloseTo(6, 9);

    // Labels name the parts under them.
    const labels = all.filter((e) => e.layer === 'LABELS');
    expect(labels.map((e) => e.groups.get(1)![0])).toEqual([
      'Plate Body',
      'Puck Body'
    ]);
    expect(layerNames(result.text)).toEqual(['Z4', 'Z7', 'Z10', 'LABELS']);

    // Parts never overlap: the puck sits to the right of the plate, a 10 mm
    // gap clear, or on a later row.
    const plateX = platePlaced!.origin[0] + platePlaced!.width;
    const sameRow = puckPlaced!.origin[1] === platePlaced!.origin[1];
    if (sameRow) {
      expect(puckPlaced!.origin[0] - plateX).toBeCloseTo(10, 9);
    } else {
      expect(puckPlaced!.origin[1]).toBeGreaterThan(
        platePlaced!.origin[1] + platePlaced!.height
      );
    }
    // Every part starts at or right of x = 0 and above y = 0.
    for (const placed of result.placements) {
      expect(placed.origin[0]).toBeGreaterThanOrEqual(0);
      expect(placed.origin[1]).toBeGreaterThan(0);
    }
  });

  it('writes the chosen unit, deterministically, and reads back as cut geometry', async () => {
    const { document, plate } = await shopDocument();
    const mm = await adapter.exportCncLayoutDxf(document, [plate]);
    const again = await adapter.exportCncLayoutDxf(document, [plate]);
    expect(again.text).toBe(mm.text);

    const inch = await adapter.exportCncLayoutDxf(document, [plate], {
      units: 'inch'
    });
    expect(inch.text).toContain('$INSUNITS\r\n70\r\n1\r\n');
    // Heights keep 1 µm in every unit: five decimals of an inch.
    expect(inch.placements[0]!.faceHeights).toEqual([0.27559, 0.3937]);
    expect(layerNames(inch.text)).toEqual(['Z0_27559', 'Z0_3937', 'LABELS']);
    const metres = await adapter.exportCncLayoutDxf(document, [plate], {
      units: 'm'
    });
    expect(layerNames(metres.text)).toEqual(['Z0_007', 'Z0_01', 'LABELS']);
    const inchCircles = entities(inch.text)
      .filter((e) => e.type === 'CIRCLE')
      .map((e) => num(e, 40))
      .sort((a, b) => a - b);
    expect(inchCircles[0]).toBeCloseTo(3 / 25.4, 9);

    // The app's own DXF reader takes every cut curve and counts the label.
    const imported = importDxfSketch(mm.text, 'mm');
    expect(imported.objects).toHaveLength(4 + 1 + 2);
    expect(imported.dropped.TEXT).toBe(1);
  });

  it('lays out every shown body when none is named, and refuses when nothing lies flat', async () => {
    const { document, ball } = await shopDocument();
    const shown = await adapter.exportCncLayoutDxf(document, []);
    expect(shown.placements.map((p) => p.name)).toEqual([
      'Plate Body',
      'Puck Body'
    ]);
    await expect(adapter.exportCncLayoutDxf(document, [ball])).rejects.toThrow(
      'Nothing to lay out: Ball Body has no flat face to lay it on.'
    );
  });
});

describe('CNC layout helpers', () => {
  it('names heights as R12 layers', () => {
    expect(cncHeightLayer(10)).toBe('Z10');
    expect(cncHeightLayer(3.5)).toBe('Z3_5');
    expect(cncHeightLayer(0.2756)).toBe('Z0_276');
    // 1 µm in any unit: a 0.4 mm plate in metres keeps its own layer.
    expect(cncHeightLayer(0.0004, 1000)).toBe('Z0_0004');
    expect(cncHeightLayer(0.27559, 25.4)).toBe('Z0_27559');
  });

  it('bounds an arc by the axis extremes it sweeps', () => {
    const bounds = cncEntityBounds([
      {
        kind: 'arc',
        center: [0, 0],
        radius: 2,
        startAngleDeg: 45,
        endAngleDeg: 135
      }
    ]);
    expect(bounds.minX).toBeCloseTo(-Math.SQRT2, 9);
    expect(bounds.minY).toBeCloseTo(Math.SQRT2, 9);
    expect(bounds.maxX).toBeCloseTo(Math.SQRT2, 9);
    expect(bounds.maxY).toBe(2);
    // Wrapping through 0°: the +X extreme is inside the sweep.
    expect(
      cncEntityBounds([
        {
          kind: 'arc',
          center: [0, 0],
          radius: 1,
          startAngleDeg: 300,
          endAngleDeg: 60
        }
      ]).maxX
    ).toBe(1);
  });

  it('keeps labels to one line of R12 text', () => {
    expect(cncLabel('Bracket ⌀8')).toBe('Bracket ⌀8');
    expect(cncLabel('Tab\tpart 🙂')).toBe('Tab?part ?');
    expect(cncLabel('x'.repeat(200))).toBe(`${'x'.repeat(113)}…`);
    // Cut by written length: each 板 is a 7-character escape in DXF.
    const wide = cncLabel('板'.repeat(37));
    expect(wide).toBe(`${'板'.repeat(16)}…`);
    expect(dxfTextLength(wide)).toBeLessThanOrEqual(120);
    expect(cncLabel('   ')).toBe('?');
  });
});

describe('CNC layout review regressions', () => {
  /** A prism of the XZ profile `points`, extruded `depth` along Y. */
  async function prism(points: [number, number][], depth: number) {
    const manager = new CommandManager(
      createProjectDocument('Prism', toUserId('user_cnc'))
    );
    manager.execute(
      composeCommands(
        'Build',
        commandsForCadPatch(
          manager.document,
          parseCadPatchProposal({
            proposalId: 'prism',
            summary: 'A prism.',
            assumptions: [],
            operations: [
              {
                kind: 'add_sketch',
                name: 'Profile',
                plane: 'XZ',
                offset: 0,
                objects: points.map(([x1, y1], index) => {
                  const [x2, y2] = points[(index + 1) % points.length]!;
                  return { objectKind: 'line', x1, y1, x2, y2 };
                }),
                localId: '$profile'
              },
              {
                kind: 'add_extrude',
                name: 'Prism',
                localId: '$prism',
                sketchId: '$profile',
                distance: depth,
                samplePoint: { x: points[0]![0] + 1, y: points[0]![1] + 1 }
              }
            ]
          })
        )
      )
    );
    const document = manager.document;
    expect((await adapter.syncDocument(document)).warnings).toEqual([]);
    return { document, bodyId: document.bodyOrder.at(-1)! };
  }

  it('refuses a top that slopes by 0.02° rather than cut it at one corner', async () => {
    // 1000 long, its top rising 0.35 mm from one end to the other.
    const { document, bodyId } = await prism(
      [
        [0, 0],
        [1000, 0],
        [1000, 10.35],
        [0, 10]
      ],
      100
    );
    await expect(
      adapter.exportCncLayoutDxf(document, [bodyId])
    ).rejects.toThrow(/has no flat face looking straight up/);
  });

  it('rests a big plate on its intact side when a small pocket opens on the other', async () => {
    let document = addPrimitiveFeature(
      createProjectDocument('Big plate', toUserId('user_cnc')),
      {
        name: 'Plate',
        primitiveKind: 'box',
        dimensions: { width: 1000, depth: 1000, height: 10 }
      }
    );
    const blank = document.bodyOrder[0]!;
    const derived = await adapter.syncDocument(document);
    // The box's height runs along Y: drill from the −Y face.
    const face = derived.bodyRepresentations[blank]!.topology!.faces.find(
      (f) =>
        f.geometry?.surfaceType === 'plane' &&
        f.geometry.normal !== undefined &&
        Math.abs(f.geometry.normal.y + 1) < 1e-9
    )!;
    const drilled = holeBody(document, {
      name: 'Pocket',
      targetBodyId: blank,
      faceHash: face.hash,
      ...(face.reference ? { faceReference: face.reference } : {}),
      style: 'simple',
      diameter: 1,
      depthMode: 'blind',
      depth: 2,
      position: { u: 0, v: 0 }
    });
    document = drilled.document;
    expect((await adapter.syncDocument(document)).warnings).toEqual([]);
    const result = await adapter.exportCncLayoutDxf(document, [drilled.bodyId]);
    // The pocketed side faces up: its opening is cut on the top layer.
    const top = entities(result.text).filter((e) => e.layer === 'Z10');
    expect(
      top.filter((e) => e.type === 'CIRCLE').map((e) => num(e, 40))
    ).toEqual([0.5]);
  });
});
