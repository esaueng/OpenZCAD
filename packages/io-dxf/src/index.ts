/**
 * Minimal DXF R12 (AC1009) writer for 2D face-outline export.
 *
 * Emits only what laser-cutting and CAM tools consume: LINE, CIRCLE, ARC,
 * and POLYLINE/VERTEX/SEQEND entities on layer 0, in millimetres. R12 is
 * deliberate — it is the most widely accepted dialect among hobby and
 * industrial cutters alike, and everything this exporter needs exists in it
 * (LWPOLYLINE would require R13+).
 *
 * The writer is pure text assembly over already-projected 2D entities; the
 * geometry extraction from a B-Rep face lives with the kernel adapter, not
 * here.
 */

export interface DxfLine {
  readonly kind: 'line';
  readonly start: readonly [number, number];
  readonly end: readonly [number, number];
}

export interface DxfCircle {
  readonly kind: 'circle';
  readonly center: readonly [number, number];
  readonly radius: number;
}

/** A circular arc, counter-clockwise from `startAngle` to `endAngle` (degrees). */
export interface DxfArc {
  readonly kind: 'arc';
  readonly center: readonly [number, number];
  readonly radius: number;
  readonly startAngleDeg: number;
  readonly endAngleDeg: number;
}

export interface DxfPolyline {
  readonly kind: 'polyline';
  readonly points: ReadonlyArray<readonly [number, number]>;
  readonly closed: boolean;
}

export type DxfEntity = DxfLine | DxfCircle | DxfArc | DxfPolyline;

/**
 * DXF forbids exponent notation, so plain `toString` (which yields `1e-7`
 * for small values) would corrupt the file. Fixed-point with trailing zeros
 * trimmed keeps files small and exact to a nanometre.
 */
export function formatDxfNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error(`DXF coordinate is not finite: ${value}`);
  }
  const fixed = value.toFixed(9);
  const trimmed = fixed.replace(/\.?0+$/, '');
  // "-0" survives toFixed for tiny negatives; normalize it.
  return trimmed === '-0' || trimmed === '' ? '0' : trimmed;
}

function group(code: number, value: string | number): string[] {
  return [String(code), typeof value === 'number' ? formatDxfNumber(value) : value];
}

function lineEntity(entity: DxfLine): string[] {
  return [
    ...group(0, 'LINE'),
    ...group(8, '0'),
    ...group(10, entity.start[0]),
    ...group(20, entity.start[1]),
    ...group(30, 0),
    ...group(11, entity.end[0]),
    ...group(21, entity.end[1]),
    ...group(31, 0)
  ];
}

function circleEntity(entity: DxfCircle): string[] {
  return [
    ...group(0, 'CIRCLE'),
    ...group(8, '0'),
    ...group(10, entity.center[0]),
    ...group(20, entity.center[1]),
    ...group(30, 0),
    ...group(40, entity.radius)
  ];
}

function arcEntity(entity: DxfArc): string[] {
  return [
    ...group(0, 'ARC'),
    ...group(8, '0'),
    ...group(10, entity.center[0]),
    ...group(20, entity.center[1]),
    ...group(30, 0),
    ...group(40, entity.radius),
    ...group(50, entity.startAngleDeg),
    ...group(51, entity.endAngleDeg)
  ];
}

function polylineEntity(entity: DxfPolyline): string[] {
  const out = [
    ...group(0, 'POLYLINE'),
    ...group(8, '0'),
    // 66=1: vertices follow as separate entities (required in R12).
    ...group(66, '1'),
    ...group(70, entity.closed ? '1' : '0')
  ];
  for (const [x, y] of entity.points) {
    out.push(...group(0, 'VERTEX'), ...group(8, '0'), ...group(10, x), ...group(20, y), ...group(30, 0));
  }
  out.push(...group(0, 'SEQEND'));
  return out;
}

/**
 * Assemble a complete R12 document from 2D entities.
 *
 * The header carries only `$ACADVER` — R12 readers need nothing else, and
 * every additional header variable is another thing an importer can choke
 * on. Coordinates are emitted as given; callers are responsible for having
 * scaled them to millimetres.
 */
export function writeDxf(entities: readonly DxfEntity[]): string {
  const lines: string[] = [
    ...group(0, 'SECTION'),
    ...group(2, 'HEADER'),
    ...group(9, '$ACADVER'),
    ...group(1, 'AC1009'),
    ...group(0, 'ENDSEC'),
    ...group(0, 'SECTION'),
    ...group(2, 'ENTITIES')
  ];
  for (const entity of entities) {
    switch (entity.kind) {
      case 'line':
        lines.push(...lineEntity(entity));
        break;
      case 'circle':
        lines.push(...circleEntity(entity));
        break;
      case 'arc':
        lines.push(...arcEntity(entity));
        break;
      case 'polyline':
        lines.push(...polylineEntity(entity));
        break;
    }
  }
  lines.push(...group(0, 'ENDSEC'), ...group(0, 'EOF'));
  return `${lines.join('\r\n')}\r\n`;
}
