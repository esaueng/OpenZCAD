import { beforeAll, describe, expect, it } from 'vitest';

import {
  addSketchFeature,
  createProjectDocument
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  sketchSvgBounds,
  writeSketchSvg
} from '../packages/kernel-adapter/src/exact-sketch-svg';
import { toUserId } from '@openzcad/shared';
import type {
  ProjectDocument,
  SketchId,
  SketchObjectData,
  UnitSystem
} from '@openzcad/shared';

/**
 * Whole-sketch SVG export (I07): the D04 sketch extraction written as exact
 * SVG lines, circles and elliptical-arc paths in DOCUMENT units, with a
 * viewBox over the exact extent and a physical size that opens at 1:1.
 */

interface SvgElement {
  name: string;
  attrs: Record<string, string>;
}

/** Elements with their attributes, in document order. Enough for flat SVG. */
function elements(svg: string): SvgElement[] {
  return [
    ...svg.matchAll(/<([a-z]+)((?:\s+[a-zA-Z0-9:-]+="[^"]*")*)\s*\/?>/g)
  ].map((match) => ({
    name: match[1]!,
    attrs: Object.fromEntries(
      [...match[2]!.matchAll(/([a-zA-Z0-9:-]+)="([^"]*)"/g)].map((attr) => [
        attr[1]!,
        attr[2]!
      ])
    )
  }));
}

const root = (svg: string) => elements(svg).find((e) => e.name === 'svg')!;
const viewBox = (svg: string) =>
  root(svg).attrs.viewBox!.split(' ').map(Number);
const drawn = (svg: string) =>
  elements(svg).filter((e) => ['line', 'circle', 'path'].includes(e.name));

describe('writeSketchSvg', () => {
  it('writes lines with v negated, in document units', () => {
    const svg = writeSketchSvg(
      [{ kind: 'line', start: [0, 0], end: [40, 10] }],
      { units: 'mm' }
    );
    const [line] = drawn(svg);
    expect(line).toEqual({
      name: 'line',
      attrs: { x1: '0', y1: '0', x2: '40', y2: '-10' }
    });
    // Half a 0.25 mm stroke of margin on every side of the exact extent.
    expect(viewBox(svg)).toEqual([-0.125, -10.125, 40.25, 10.25]);
    expect(root(svg).attrs.width).toBe('40.25mm');
    expect(root(svg).attrs.height).toBe('10.25mm');
    const group = elements(svg).find((e) => e.name === 'g')!;
    expect(group.attrs).toMatchObject({
      fill: 'none',
      stroke: '#000000',
      'stroke-width': '0.25'
    });
  });

  it('writes a circle exactly, never as segments', () => {
    const svg = writeSketchSvg(
      [{ kind: 'circle', center: [5, 7], radius: 3 }],
      { units: 'mm' }
    );
    expect(drawn(svg)).toEqual([
      { name: 'circle', attrs: { cx: '5', cy: '-7', r: '3' } }
    ]);
    expect(viewBox(svg)).toEqual([1.875, -10.125, 6.25, 6.25]);
  });

  it('writes a counter-clockwise arc as one SVG arc command', () => {
    const svg = writeSketchSvg(
      [
        {
          kind: 'arc',
          center: [0, 0],
          radius: 10,
          startAngleDeg: 0,
          endAngleDeg: 90
        }
      ],
      { units: 'mm' }
    );
    const [path] = drawn(svg);
    // From (10, 0) to (0, 10): with v negated, CCW is sweep flag 0.
    expect(path!.attrs.d).toBe('M10 0 A10 10 0 0 0 0 -10');
    // Bounds are the quarter itself, not the full circle.
    const bounds = sketchSvgBounds([
      {
        kind: 'arc',
        center: [0, 0],
        radius: 10,
        startAngleDeg: 0,
        endAngleDeg: 90
      }
    ]);
    expect(bounds.minX).toBeCloseTo(0, 12);
    expect(bounds.minY).toBeCloseTo(0, 12);
    expect(bounds.maxX).toBe(10);
    expect(bounds.maxY).toBe(10);
  });

  it('flags arcs over 180° as large and includes every axis extreme crossed', () => {
    const arc = {
      kind: 'arc' as const,
      center: [0, 0] as const,
      radius: 2,
      startAngleDeg: 45,
      endAngleDeg: -45 // CCW from 45° round to 315°: a 270° sweep
    };
    const [path] = drawn(writeSketchSvg([arc], { units: 'mm' }));
    expect(path!.attrs.d).toMatch(
      /^M1\.414213562 -1\.414213562 A2 2 0 1 0 1\.414213562 1\.414213562$/
    );
    const bounds = sketchSvgBounds([arc]);
    expect(bounds.minX).toBe(-2);
    expect(bounds.minY).toBe(-2);
    expect(bounds.maxY).toBe(2);
    expect(bounds.maxX).toBeCloseTo(Math.SQRT2, 12);
  });

  it('states physical size in the document unit, and metres in millimetres', () => {
    const entities = [
      { kind: 'line' as const, start: [0, 0] as const, end: [2, 1] as const }
    ];
    const sizes: Record<UnitSystem, [string, string]> = {
      mm: ['2.25mm', '1.25mm'],
      cm: ['2.025cm', '1.025cm'],
      inch: ['2.009842520in', '1.009842520in'],
      m: ['2000.25mm', '1000.25mm']
    };
    for (const [units, [width, height]] of Object.entries(sizes) as Array<
      [UnitSystem, [string, string]]
    >) {
      const svg = writeSketchSvg(entities, { units });
      // One user unit is one document unit whatever the unit is.
      expect(drawn(svg)[0]!.attrs.x2).toBe('2');
      expect(Number.parseFloat(root(svg).attrs.width!)).toBeCloseTo(
        Number.parseFloat(width),
        8
      );
      expect(root(svg).attrs.width!.replace(/[\d.]/g, '')).toBe(
        width.replace(/[\d.]/g, '')
      );
      expect(Number.parseFloat(root(svg).attrs.height!)).toBeCloseTo(
        Number.parseFloat(height),
        8
      );
    }
  });

  it('paints a white background only when transparency is off', () => {
    const entities = [
      { kind: 'circle' as const, center: [0, 0] as const, radius: 1 }
    ];
    expect(
      elements(writeSketchSvg(entities, { units: 'mm' })).some(
        (e) => e.name === 'rect'
      )
    ).toBe(false);
    const opaque = writeSketchSvg(entities, {
      units: 'mm',
      transparent: false
    });
    const rect = elements(opaque).find((e) => e.name === 'rect')!;
    expect(rect.attrs).toEqual({
      x: '-1.125',
      y: '-1.125',
      width: '2.25',
      height: '2.25',
      fill: '#ffffff'
    });
  });

  it('writes an ellipse as exact half-turn arc commands with its exact extent', () => {
    // I01: a 20 × 10 ellipse, its major axis turned 45°. Each axis reaches
    // √(a²cos²θ + b²sin²θ) = √250 from the centre.
    const reach = Math.sqrt(250);
    const svg = writeSketchSvg(
      [
        {
          kind: 'ellipse',
          center: [0, 0],
          majorAxis: [20 * Math.SQRT1_2, 20 * Math.SQRT1_2],
          ratio: 0.5,
          startParam: 0,
          endParam: 2 * Math.PI
        }
      ],
      { units: 'mm' }
    );
    const [path] = drawn(svg);
    const d = path!.attrs.d!;
    // Two arcs of rx 20, ry 10, tilted −45° once v is negated.
    expect(d.match(/A20 10 -45 0 0 /g)).toHaveLength(2);
    const [x, y, width, height] = viewBox(svg);
    expect(x).toBeCloseTo(-reach - 0.125, 9);
    expect(y).toBeCloseTo(-reach - 0.125, 9);
    expect(width).toBeCloseTo(2 * reach + 0.25, 9);
    expect(height).toBeCloseTo(2 * reach + 0.25, 9);
  });

  it('writes a spline as exact Bézier commands with its exact extent', () => {
    // One cubic span: its top is at t = ½, y = 7.5, below its controls' 10.
    const svg = writeSketchSvg(
      [
        {
          kind: 'spline',
          degree: 3,
          knots: [0, 0, 0, 0, 1, 1, 1, 1],
          controls: [
            [0, 0],
            [0, 10],
            [10, 10],
            [10, 0]
          ]
        }
      ],
      { units: 'mm' }
    );
    const [path] = drawn(svg);
    expect(path!.attrs.d).toBe('M0 0 C0 -10 10 -10 10 0');
    expect(viewBox(svg)).toEqual([-0.125, -7.625, 10.25, 7.75]);
  });

  it('escapes the title and refuses an empty drawing', () => {
    const svg = writeSketchSvg([{ kind: 'line', start: [0, 0], end: [1, 0] }], {
      units: 'mm',
      title: 'Plate <A> & "B"'
    });
    expect(svg).toContain('<title>Plate &lt;A&gt; &amp; &quot;B&quot;</title>');
    expect(() => writeSketchSvg([], { units: 'mm' })).toThrow(/at least one/);
  });
});

let adapter: ExactKernelAdapter;

beforeAll(async () => {
  adapter = await createExactKernelAdapter();
});

function sketchDocument(
  objects: SketchObjectData[],
  units: UnitSystem = 'mm'
): { document: ProjectDocument; sketchId: SketchId } {
  const root = createProjectDocument('Svg', toUserId('user_sketchsvg'), units);
  return addSketchFeature(root, {
    name: 'Plate outline',
    planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
    objects
  });
}

describe('exportSketchSvg', { timeout: 120_000 }, () => {
  it('draws lines, arcs and circles from the saved sketch in document units', async () => {
    const { document, sketchId } = sketchDocument(
      [
        { objectKind: 'line', x1: 0, y1: 0, x2: 2, y2: 0 },
        {
          objectKind: 'arc',
          centerX: 2,
          centerY: 1,
          radius: 1,
          startAngleDeg: -90,
          endAngleDeg: 90
        },
        { objectKind: 'circle', centerX: 1, centerY: 1, radius: 0.25 },
        {
          objectKind: 'line',
          x1: 0,
          y1: 0,
          x2: 0,
          y2: 2,
          construction: true
        }
      ],
      'inch'
    );
    const svg = await adapter.exportSketchSvg(document, sketchId);
    expect(svg).toContain('<title>Plate outline</title>');
    expect(drawn(svg).map((e) => e.name)).toEqual(['line', 'path', 'circle']);
    // Inches stay inches: no millimetre scaling anywhere in the drawing.
    expect(drawn(svg)[0]!.attrs).toEqual({
      x1: '0',
      y1: '0',
      x2: '2',
      y2: '0'
    });
    expect(drawn(svg)[1]!.attrs.d).toBe('M2 0 A1 1 0 0 0 2 -2');
    expect(drawn(svg)[2]!.attrs).toEqual({ cx: '1', cy: '-1', r: '0.25' });
    expect(root(svg).attrs.width!.endsWith('in')).toBe(true);
    // Extent 0..3 by 0..2 (the construction line is not drawn or counted).
    const [x, y, width, height] = viewBox(svg);
    const pad = 0.125 / 25.4;
    expect(x).toBeCloseTo(-pad, 9);
    expect(y).toBeCloseTo(-2 - pad, 9);
    expect(width).toBeCloseTo(3 + 2 * pad, 9);
    expect(height).toBeCloseTo(2 + 2 * pad, 9);
  });

  it('expands rectangles to their edges and honours the background choice', async () => {
    const { document, sketchId } = sketchDocument([
      { objectKind: 'rectangle', width: 30, height: 10, centerX: 0, centerY: 0 }
    ]);
    const svg = await adapter.exportSketchSvg(document, sketchId, {
      transparent: false
    });
    expect(drawn(svg).map((e) => e.name)).toEqual([
      'line',
      'line',
      'line',
      'line'
    ]);
    expect(elements(svg).some((e) => e.name === 'rect')).toBe(true);
  });

  it('draws a saved elliptical arc and spline exactly', async () => {
    const { document, sketchId } = sketchDocument([
      {
        objectKind: 'ellipse',
        centerX: 0,
        centerY: 0,
        radiusX: 10,
        radiusY: 20,
        rotationDeg: 0,
        startParamDeg: 0,
        endParamDeg: 180
      },
      {
        objectKind: 'spline',
        method: 'fit',
        points: [
          { x: -10, y: 0 },
          { x: 0, y: -8 },
          { x: 10, y: 0 }
        ]
      }
    ]);
    const svg = await adapter.exportSketchSvg(document, sketchId);
    const [arc, curve] = drawn(svg);
    // Taller than wide: stated on its 20 major axis, standing at −90°.
    expect(arc!.attrs.d).toMatch(/^M10 0 A20 10 -90 0 0 -10 0$/);
    // Three fit points interpolate as one quadratic span: a single exact Q
    // command through the end point, never sampled L segments.
    expect(curve!.attrs.d).toMatch(/^M-10 0 Q-?[\d.]+ -?[\d.]+ 10 0$/);
  });

  it('refuses the sketches the DXF export refuses, by the same names', async () => {
    const constructionOnly = sketchDocument([
      { objectKind: 'line', x1: 0, y1: 0, x2: 1, y2: 0, construction: true }
    ]);
    await expect(
      adapter.exportSketchSvg(
        constructionOnly.document,
        constructionOnly.sketchId
      )
    ).rejects.toThrow('construction-only');
    await expect(
      adapter.exportSketchSvg(
        constructionOnly.document,
        'sketch_missing' as SketchId
      )
    ).rejects.toThrow('sketch-not-found');
  });
});
