import { parseStl } from '@openzcad/io-stl';
import {
  importMeshFile,
  type ExactKernelAdapter,
  type MeshExportFormat
} from '@openzcad/kernel-adapter/exact';
import {
  UNIT_TO_MM,
  type BodyId,
  type ProjectDocument,
  type SketchId,
  type SketchObjectData,
  type UnitSystem
} from '@openzcad/shared';
import {
  RemusKernel,
  loadRemusTranslators
} from '../../packages/kernel-adapter/src/remus-runtime';
import { readThreeMfPackage } from '../../packages/kernel-adapter/src/three-mf-package';
import { importDxfSketch } from '../../apps/web/src/lib/dxfImport';
import { verticesReadAs } from '../../apps/web/src/lib/importUnits';

/**
 * The shared export → reimport harness behind the loss contract
 * (`exchange-loss-contract.ts`). Each format is exported through the app's
 * own adapter call, then read back through the path the app imports it
 * with — the paired STEP reader, `parseStl`, `importMeshFile`,
 * `importDxfSketch` — and measured the same way for every format, so the
 * contract compares like with like. SVG has no reader; it is measured from
 * the file itself.
 */

export type SolidExchangeFormat =
  'step' | 'stl-binary' | 'stl' | '3mf' | 'obj' | 'ply' | 'glb';

export interface SolidMeasure {
  /** Bodies the reimport yields (a mesh import is always one body). */
  bodyCount: number;
  /** Objects the file itself keeps apart, where the format can say. */
  fileObjects: number | null;
  /** Millimetres. */
  bounds: { min: [number, number, number]; max: [number, number, number] };
  /** Cubic millimetres. */
  volume: number;
  watertight: boolean;
  /** Any curved analytic face came back as such (not as triangles). */
  exactFaces: boolean;
  /** The length unit the file states, or null when it states none. */
  declaredUnits: UnitSystem | null;
  /** Whether any of the given body names appears in the file. */
  bodyNames: boolean;
  /** Whether the file carries colour or material markup. */
  bodyColors: boolean;
  /** Triangles in the file (mesh formats). */
  triangles: number | null;
  bytes: Uint8Array;
}

/** Writes `format` through the adapter, as the export dialog does. */
export async function exportSolids(
  adapter: ExactKernelAdapter,
  document: ProjectDocument,
  bodyIds: BodyId[],
  format: SolidExchangeFormat,
  options: { units?: UnitSystem; deflection?: number } = {}
): Promise<Uint8Array> {
  const units = options.units ?? 'mm';
  if (format === 'step') {
    return new TextEncoder().encode(
      await adapter.exportStep(document, bodyIds, { units })
    );
  }
  const meshFormat: MeshExportFormat = format === 'stl' ? 'stl-ascii' : format;
  return adapter.exportMesh(document, bodyIds, {
    format: meshFormat,
    deflection: options.deflection ?? 0.08,
    units
  });
}

const latin1 = new TextDecoder('latin1');

function stepDeclaredUnits(step: string): UnitSystem | null {
  if (/CONVERSION_BASED_UNIT\(\s*'INCH'/.test(step)) return 'inch';
  const si =
    /LENGTH_UNIT\(\s*\)\s*NAMED_UNIT\(\s*\*\s*\)\s*SI_UNIT\(\s*([^,]+?)\s*,\s*\.METRE\.\s*\)/.exec(
      step
    );
  if (!si) return null;
  return si[1] === '.MILLI.' ? 'mm' : si[1] === '.CENTI.' ? 'cm' : 'm';
}

const THREE_MF_UNITS: Record<string, UnitSystem> = {
  millimeter: 'mm',
  centimeter: 'cm',
  meter: 'm',
  inch: 'inch'
};

/** Bounds, volume and closure of a triangle soup, by welded position. */
export function measureTriangles(
  vertices: ArrayLike<number>,
  indices: ArrayLike<number>
) {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index + 2 < vertices.length; index += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis]!, vertices[index + axis]!);
      max[axis] = Math.max(max[axis]!, vertices[index + axis]!);
    }
  }
  const key = (vertex: number) =>
    [0, 1, 2]
      .map((axis) => Math.round(vertices[vertex * 3 + axis]! * 1e4))
      .join(',');
  const welded = new Map<string, number>();
  const id = (vertex: number) => {
    const k = key(vertex);
    if (!welded.has(k)) welded.set(k, welded.size);
    return welded.get(k)!;
  };
  const edgeUses = new Map<string, number>();
  let volume = 0;
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const corners = [indices[t]!, indices[t + 1]!, indices[t + 2]!];
    const ids = corners.map(id);
    for (let k = 0; k < 3; k += 1) {
      const a = ids[k]!;
      const b = ids[(k + 1) % 3]!;
      const edge = a < b ? `${a}_${b}` : `${b}_${a}`;
      edgeUses.set(edge, (edgeUses.get(edge) ?? 0) + 1);
    }
    const [p, q, r] = corners.map((c) => [
      vertices[c * 3]!,
      vertices[c * 3 + 1]!,
      vertices[c * 3 + 2]!
    ]);
    volume +=
      (p![0]! * (q![1]! * r![2]! - q![2]! * r![1]!) -
        p![1]! * (q![0]! * r![2]! - q![2]! * r![0]!) +
        p![2]! * (q![0]! * r![1]! - q![1]! * r![0]!)) /
      6;
  }
  return {
    bounds: { min, max },
    volume: Math.abs(volume),
    watertight: [...edgeUses.values()].every((uses) => uses === 2),
    triangles: indices.length / 3
  };
}

/**
 * Reads an export back the way the app imports it. `reading` is the unit
 * the user tells a unitless import (STL, OBJ, PLY) — the export unit, for a
 * faithful round trip.
 */
export async function reimportSolids(
  format: SolidExchangeFormat,
  bytes: Uint8Array,
  options: { reading?: UnitSystem; bodyNames?: readonly string[] } = {}
): Promise<SolidMeasure> {
  const text = latin1.decode(bytes);
  const bodyNames = (options.bodyNames ?? []).some((name) =>
    text.includes(name)
  );
  if (format === 'step') {
    const kernel = new RemusKernel();
    const io = await loadRemusTranslators();
    const solids = [...kernel.deserializeSolids(io.importStep(bytes))];
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    let volume = 0;
    let valid = solids.length > 0;
    let exactFaces = false;
    for (const solid of solids) {
      const box = kernel.boundingBox(solid);
      for (let axis = 0; axis < 3; axis += 1) {
        min[axis] = Math.min(min[axis]!, box[axis]!);
        max[axis] = Math.max(max[axis]!, box[axis + 3]!);
      }
      volume += kernel.volume(solid, 0.001);
      valid &&= kernel.validateSolid(solid) === 0;
      exactFaces ||= [...kernel.getSolidFaces(solid)].some(
        (face) => kernel.getSurfaceType(face) === 'cylinder'
      );
    }
    return {
      bodyCount: solids.length,
      fileObjects: (text.match(/MANIFOLD_SOLID_BREP/g) ?? []).length,
      bounds: { min, max },
      volume,
      watertight: valid,
      exactFaces,
      declaredUnits: stepDeclaredUnits(text),
      bodyNames,
      bodyColors: /COLOUR_RGB|STYLED_ITEM/.test(text),
      triangles: null,
      bytes
    };
  }

  const reading = options.reading ?? 'mm';
  let vertices: number[];
  let indices: number[];
  let declaredUnits: UnitSystem | null = null;
  let fileObjects: number | null = null;
  if (format === 'stl' || format === 'stl-binary') {
    const parsed = parseStl(bytes.slice().buffer, 'round-trip.stl');
    vertices = verticesReadAs(parsed.vertices, reading);
    indices = parsed.indices;
  } else {
    const imported = await importMeshFile(format, bytes, 'mm');
    indices = imported.indices;
    if (format === 'obj' || format === 'ply') {
      vertices = verticesReadAs(imported.vertices, reading);
    } else {
      vertices = imported.vertices;
      if (format === '3mf') {
        const pack = await readThreeMfPackage(bytes);
        declaredUnits = THREE_MF_UNITS[pack.unit.name] ?? null;
        fileObjects = pack.placements.length;
      } else {
        declaredUnits = 'm';
      }
    }
  }
  const measured = measureTriangles(vertices, indices);
  return {
    bodyCount: 1,
    fileObjects,
    ...measured,
    exactFaces: false,
    declaredUnits,
    bodyNames,
    bodyColors:
      format === 'obj'
        ? /^(mtllib|usemtl)\b/m.test(text)
        : format === 'ply'
          ? /property\s+\w+\s+(red|green|blue)\b/.test(text)
          : format === 'glb'
            ? /"materials"\s*:/.test(text)
            : format === '3mf'
              ? /basematerials|colorgroup/.test(text)
              : false,
    bytes
  };
}

/** One sketch's 2D curves, as a sketch import or the file itself holds them. */
export interface SketchMeasure {
  /** Curve counts by kind. */
  kinds: Record<string, number>;
  /** Line endpoints, circle and arc centres and radii, in millimetres. */
  coordinates: number[];
  declaredUnits: UnitSystem | null;
  /** Physical width and height the file states, millimetres (SVG). */
  physicalSize: [number, number] | null;
}

/** The sketch-object numbers a round trip compares, scaled to millimetres. */
export function sketchCoordinates(
  objects: readonly SketchObjectData[],
  scaleToMm: number
): number[] {
  return objects
    .filter((object) => !object.construction)
    .flatMap((object) => {
      switch (object.objectKind) {
        case 'line':
          return [object.x1, object.y1, object.x2, object.y2];
        case 'circle':
          return [object.centerX, object.centerY, object.radius];
        case 'arc':
          return [object.centerX, object.centerY, object.radius];
        default:
          return [];
      }
    })
    .map((value) => Number(value) * scaleToMm);
}

function kindsOf(objects: readonly SketchObjectData[]): Record<string, number> {
  const kinds: Record<string, number> = {};
  for (const object of objects) {
    if (object.construction) continue;
    kinds[object.objectKind] = (kinds[object.objectKind] ?? 0) + 1;
  }
  return kinds;
}

const DXF_UNITS: Record<string, UnitSystem> = {
  '1': 'inch',
  '4': 'mm',
  '5': 'cm',
  '6': 'm'
};

/** Sketch DXF export → the app's DXF sketch import, read into millimetres. */
export async function roundTripSketchDxf(
  adapter: ExactKernelAdapter,
  document: ProjectDocument,
  sketchId: SketchId,
  units: UnitSystem
): Promise<SketchMeasure & { text: string }> {
  const text = await adapter.exportSketchDxf(document, sketchId, { units });
  const imported = importDxfSketch(text, 'mm');
  const code = /\$INSUNITS\r\n\s*70\r\n\s*(\d+)/.exec(text)?.[1];
  return {
    text,
    kinds: kindsOf(imported.objects),
    coordinates: sketchCoordinates(imported.objects, 1),
    declaredUnits: code ? (DXF_UNITS[code] ?? null) : null,
    physicalSize: null
  };
}

const SVG_SUFFIX_MM: Record<string, number> = { mm: 1, cm: 10, in: 25.4 };

/**
 * Sketch SVG export, measured from the file: there is no SVG import (I07),
 * so this is an independent reparse of what the writer states, not a
 * round trip through the app.
 */
export async function measureSketchSvg(
  adapter: ExactKernelAdapter,
  document: ProjectDocument,
  sketchId: SketchId
): Promise<SketchMeasure & { text: string }> {
  const text = await adapter.exportSketchSvg(document, sketchId);
  const root = /<svg\b[^>]*>/.exec(text)?.[0] ?? '';
  const length = (name: string) => {
    const match = new RegExp(`\\b${name}="([\\d.]+)(mm|cm|in)"`).exec(root);
    return match ? Number(match[1]) * SVG_SUFFIX_MM[match[2]!]! : NaN;
  };
  const suffix = /\bwidth="[\d.]+(mm|cm|in)"/.exec(root)?.[1];
  const scale = UNIT_TO_MM[document.units];
  const numbers = (tag: string, attributes: string[]) =>
    [...text.matchAll(new RegExp(`<${tag}\\b[^>]*/>`, 'g'))].map(([element]) =>
      attributes.map((attribute) =>
        Number(new RegExp(`\\b${attribute}="([^"]+)"`).exec(element)![1])
      )
    );
  const lines = numbers('line', ['x1', 'y1', 'x2', 'y2']);
  const circles = numbers('circle', ['cx', 'cy', 'r']);
  const arcs = [...text.matchAll(/<path d="M[^"]* A/g)].length;
  return {
    text,
    kinds: {
      ...(lines.length ? { line: lines.length } : {}),
      ...(circles.length ? { circle: circles.length } : {}),
      ...(arcs ? { arc: arcs } : {})
    },
    // SVG's y runs down: the writer flips it, so flip it back to compare.
    coordinates: [
      ...lines.flatMap(([x1, y1, x2, y2]) => [x1!, -y1!, x2!, -y2!]),
      ...circles.flatMap(([cx, cy, r]) => [cx!, -cy!, r!])
    ].map((value) => (value || 0) * scale),
    declaredUnits:
      suffix === 'in' ? 'inch' : suffix === 'cm' ? 'cm' : suffix ? 'mm' : null,
    physicalSize: [length('width'), length('height')]
  };
}
