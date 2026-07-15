import { describe, expect, it } from 'vitest';
import { makeBox, makeCylinder, transformSolid } from '@openzcad/geometry';
import { parseStepMetadata, writeStepFile } from '@openzcad/io-step';

interface ParsedStep {
  entities: Map<number, string>;
  header: string;
}

function parseStep(text: string): ParsedStep {
  expect(text.startsWith('ISO-10303-21;')).toBe(true);
  expect(text.trimEnd().endsWith('END-ISO-10303-21;')).toBe(true);
  const headerMatch = /HEADER;([\s\S]*?)ENDSEC;/.exec(text);
  const dataMatch = /DATA;([\s\S]*?)ENDSEC;/.exec(text);
  expect(headerMatch).toBeTruthy();
  expect(dataMatch).toBeTruthy();

  const entities = new Map<number, string>();
  for (const line of dataMatch![1]!.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const match = /^#(\d+)=(.*);$/.exec(trimmed);
    expect(match, `malformed instance line: ${trimmed}`).toBeTruthy();
    entities.set(Number(match![1]), match![2]!);
  }
  return { entities, header: headerMatch![1]! };
}

function entityIds(parsed: ParsedStep, type: string): number[] {
  const ids: number[] = [];
  for (const [id, body] of parsed.entities) {
    if (body.startsWith(`${type}(`)) {
      ids.push(id);
    }
  }
  return ids;
}

const boxFile = () =>
  writeStepFile([{ name: 'Cube', solid: makeBox(10, 20, 30) }], {
    name: 'Box Part',
    units: 'mm',
    timestamp: '2026-01-01T00:00:00.000Z'
  });

describe('STEP writer', () => {
  it('writes a structurally valid AP214 part 21 file', () => {
    const { text, warnings } = boxFile();
    expect(warnings).toEqual([]);
    const parsed = parseStep(text);

    expect(parsed.header).toContain("FILE_SCHEMA(('AUTOMOTIVE_DESIGN");
    expect(parsed.header).toContain("'Box Part.step'");

    // Every #n reference inside the data section must resolve.
    for (const [id, body] of parsed.entities) {
      for (const match of body.matchAll(/#(\d+)/g)) {
        const ref = Number(match[1]);
        expect(parsed.entities.has(ref), `entity #${id} references missing #${ref}`).toBe(
          true
        );
      }
    }

    expect(entityIds(parsed, 'PRODUCT')).toHaveLength(1);
    expect(entityIds(parsed, 'PRODUCT_DEFINITION_SHAPE')).toHaveLength(1);
    expect(entityIds(parsed, 'SHAPE_DEFINITION_REPRESENTATION')).toHaveLength(1);
    expect(entityIds(parsed, 'ADVANCED_BREP_SHAPE_REPRESENTATION')).toHaveLength(1);
    expect(entityIds(parsed, 'MANIFOLD_SOLID_BREP')).toHaveLength(1);
    expect(entityIds(parsed, 'CLOSED_SHELL')).toHaveLength(1);
  });

  it('emits exact box topology with paired oriented edges (Euler V-E+F=2)', () => {
    const parsed = parseStep(boxFile().text);

    const vertexCount = entityIds(parsed, 'VERTEX_POINT').length;
    const edgeCount = entityIds(parsed, 'EDGE_CURVE').length;
    const faceCount = entityIds(parsed, 'ADVANCED_FACE').length;
    expect(vertexCount).toBe(8);
    expect(edgeCount).toBe(12);
    expect(faceCount).toBe(6);
    expect(vertexCount - edgeCount + faceCount).toBe(2);

    // Each EDGE_CURVE must be used by exactly two ORIENTED_EDGEs with
    // opposite senses — the watertightness contract of a closed shell.
    const usage = new Map<number, string[]>();
    for (const id of entityIds(parsed, 'ORIENTED_EDGE')) {
      const body = parsed.entities.get(id)!;
      const match = /#(\d+),(\.[TF]\.)\)$/.exec(body);
      expect(match, `unparsable ORIENTED_EDGE: ${body}`).toBeTruthy();
      const curve = Number(match![1]);
      const senses = usage.get(curve) ?? [];
      senses.push(match![2]!);
      usage.set(curve, senses);
    }
    expect(usage.size).toBe(12);
    for (const senses of usage.values()) {
      expect(senses.sort()).toEqual(['.F.', '.T.']);
    }
  });

  it('keeps Euler characteristic 2 for tessellated solids', () => {
    const { text } = writeStepFile([{ name: 'Cyl', solid: makeCylinder(8, 20) }], {
      name: 'Cylinder',
      units: 'mm'
    });
    const parsed = parseStep(text);
    const v = entityIds(parsed, 'VERTEX_POINT').length;
    const e = entityIds(parsed, 'EDGE_CURVE').length;
    const f = entityIds(parsed, 'ADVANCED_FACE').length;
    expect(v - e + f).toBe(2);
  });

  it('scales inch documents to millimetres', () => {
    const { text } = writeStepFile([{ name: 'InchCube', solid: makeBox(2, 2, 2) }], {
      name: 'Inch Part',
      units: 'inch'
    });
    // The cube spans 2 inches from the origin, i.e. 50.8 mm.
    expect(text).toContain('50.8');
    expect(text).toContain('SI_UNIT(.MILLI.,.METRE.)');
  });

  it('writes multiple bodies into one shape representation', () => {
    const second = transformSolid(makeBox(5, 5, 5), {
      translation: { x: 30, y: 0, z: 0 },
      rotationDeg: { x: 0, y: 0, z: 0 }
    });
    const { text } = writeStepFile(
      [
        { name: 'Left', solid: makeBox(5, 5, 5) },
        { name: 'Right', solid: second }
      ],
      { name: 'Pair', units: 'mm' }
    );
    const parsed = parseStep(text);
    expect(entityIds(parsed, 'MANIFOLD_SOLID_BREP')).toHaveLength(2);
    expect(entityIds(parsed, 'ADVANCED_BREP_SHAPE_REPRESENTATION')).toHaveLength(1);
  });

  it('escapes quotes in names and refuses empty exports', () => {
    const { text } = writeStepFile([{ name: "O'Ring", solid: makeBox(1, 1, 1) }], {
      name: "Part 'X'",
      units: 'mm'
    });
    expect(text).toContain("MANIFOLD_SOLID_BREP('O''Ring'");
    expect(() => writeStepFile([], { name: 'Empty', units: 'mm' })).toThrow(/at least one/);
  });
});

describe('STEP metadata parsing', () => {
  it('extracts product names from a STEP file', () => {
    const { text } = boxFile();
    const metadata = parseStepMetadata('box.step', text);
    expect(metadata.products).toContain('Box Part');
  });
});
