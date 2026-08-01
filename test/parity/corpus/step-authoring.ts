/**
 * Hand-authoring helpers for the parity corpus.
 *
 * Several corpus categories cannot be produced by exporting through an
 * adapter, because the thing under test is precisely what our exporters never
 * emit: inch `CONVERSION_BASED_UNIT` length contexts, degree plane angles,
 * a missing `GLOBAL_UNIT_ASSIGNED_CONTEXT`, and `BREP_WITH_VOIDS` cavities
 * (BrepKit's `write_solid` silently drops inner shells — K0.1 step 2).
 *
 * So those files are emitted here instead, from a deliberately tiny AP214
 * writer that only knows how to lay down axis-aligned planar box shells. Small
 * output matters: every corpus file is committed, read by humans chasing a
 * kernel delta, and diffed when it is re-recorded. A box shell is ~120
 * entities and stays legible.
 *
 * Nothing here is a general STEP writer. `@openzcad/io-step` is that; this is
 * the escape hatch for the malformed-on-purpose and exporter-unreachable
 * cases.
 */

export interface Vec3Lit {
  x: number;
  y: number;
  z: number;
}

export interface BoxSpec {
  min: Vec3Lit;
  max: Vec3Lit;
}

/** Length unit declaration for the emitted `GLOBAL_UNIT_ASSIGNED_CONTEXT`. */
export type LengthUnit =
  | { kind: 'millimetre' }
  /**
   * `CONVERSION_BASED_UNIT` over an SI millimetre base — the shape a real
   * inch-authored file takes. Coordinates in the file are then in `name`
   * units and a conforming reader must scale them by `factorMm`.
   */
  | { kind: 'conversion'; name: string; factorMm: number };

/** Plane-angle unit declaration. */
export type AngleUnit =
  | { kind: 'radian' }
  | { kind: 'conversion'; name: string; factorRadians: number };

export interface StepContextSpec {
  length: LengthUnit;
  angle: AngleUnit;
  /**
   * Emit the `GLOBAL_UNIT_ASSIGNED_CONTEXT` at all. When false the units are
   * still declared as free-standing entities but nothing binds them to the
   * representation context — the case a kernel may legitimately turn into a
   * hard refusal, and which the corpus exists to make audible.
   */
  assignUnits: boolean;
}

export const MILLIMETRE_CONTEXT: StepContextSpec = {
  length: { kind: 'millimetre' },
  angle: { kind: 'radian' },
  assignUnits: true
};

/** STEP REAL literal. Always carries a '.' so it cannot be read as an integer. */
function real(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error(`cannot write non-finite STEP real: ${value}`);
  }
  if (Number.isInteger(value) && Math.abs(value) < 1e15) {
    return `${value}.`;
  }
  const text = value.toPrecision(17);
  return text.includes('.') || text.includes('E') ? text : `${text}.`;
}

/** Incrementing `#n` allocator so hand-authored files stay densely numbered. */
class EntityWriter {
  private next = 1;
  readonly lines: string[] = [];

  add(body: string): string {
    const id = `#${this.next}`;
    this.next += 1;
    this.lines.push(`${id}=${body};`);
    return id;
  }

  comment(text: string): void {
    this.lines.push(`/* ${text} */`);
  }

  point(p: Vec3Lit): string {
    return this.add(
      `CARTESIAN_POINT('',(${real(p.x)},${real(p.y)},${real(p.z)}))`
    );
  }

  direction(p: Vec3Lit): string {
    return this.add(`DIRECTION('',(${real(p.x)},${real(p.y)},${real(p.z)}))`);
  }

  placement(origin: Vec3Lit, axis: Vec3Lit, ref: Vec3Lit): string {
    const o = this.point(origin);
    const a = this.direction(axis);
    const r = this.direction(ref);
    return this.add(`AXIS2_PLACEMENT_3D('',${o},${a},${r})`);
  }
}

/**
 * The six outward-oriented faces of an axis-aligned box.
 *
 * Each face gets its own plane whose placement axis IS the outward normal, and
 * the vertex loop is listed counter-clockwise as seen from outside, so every
 * `ADVANCED_FACE` can use `.T.` and the shell's orientation is readable
 * without tracing sense flags. Vertex indices follow the corner numbering
 * v0..v3 = bottom (z-min) CCW-from-below, v4..v7 = top.
 */
const BOX_FACES: ReadonlyArray<{
  label: string;
  loop: readonly [number, number, number, number];
  /** Corner index supplying the plane origin. */
  origin: number;
  normal: Vec3Lit;
  ref: Vec3Lit;
}> = [
  {
    label: 'z-min',
    loop: [0, 3, 2, 1],
    origin: 0,
    normal: { x: 0, y: 0, z: -1 },
    ref: { x: 1, y: 0, z: 0 }
  },
  {
    label: 'z-max',
    loop: [4, 5, 6, 7],
    origin: 4,
    normal: { x: 0, y: 0, z: 1 },
    ref: { x: 1, y: 0, z: 0 }
  },
  {
    label: 'y-min',
    loop: [0, 1, 5, 4],
    origin: 0,
    normal: { x: 0, y: -1, z: 0 },
    ref: { x: 1, y: 0, z: 0 }
  },
  {
    label: 'x-max',
    loop: [1, 2, 6, 5],
    origin: 1,
    normal: { x: 1, y: 0, z: 0 },
    ref: { x: 0, y: 1, z: 0 }
  },
  {
    label: 'y-max',
    loop: [2, 3, 7, 6],
    origin: 2,
    normal: { x: 0, y: 1, z: 0 },
    ref: { x: -1, y: 0, z: 0 }
  },
  {
    label: 'x-min',
    loop: [3, 0, 4, 7],
    origin: 3,
    normal: { x: -1, y: 0, z: 0 },
    ref: { x: 0, y: -1, z: 0 }
  }
];

function boxCorners(box: BoxSpec): Vec3Lit[] {
  const { min, max } = box;
  return [
    { x: min.x, y: min.y, z: min.z },
    { x: max.x, y: min.y, z: min.z },
    { x: max.x, y: max.y, z: min.z },
    { x: min.x, y: max.y, z: min.z },
    { x: min.x, y: min.y, z: max.z },
    { x: max.x, y: min.y, z: max.z },
    { x: max.x, y: max.y, z: max.z },
    { x: min.x, y: max.y, z: max.z }
  ];
}

/**
 * Emit one outward-oriented `CLOSED_SHELL` for an axis-aligned box and return
 * its entity id. Edge curves are shared between the two faces that use them —
 * an unshared edge is the classic way a hand-authored shell reads as open.
 */
function writeBoxShell(
  writer: EntityWriter,
  box: BoxSpec,
  label: string
): string {
  writer.comment(
    `${label}: axis-aligned box shell ` +
      `(${real(box.min.x)},${real(box.min.y)},${real(box.min.z)}) .. ` +
      `(${real(box.max.x)},${real(box.max.y)},${real(box.max.z)})`
  );
  const corners = boxCorners(box);
  const vertices = corners.map((corner) =>
    writer.add(`VERTEX_POINT('',${writer.point(corner)})`)
  );

  const edgeCurves = new Map<string, string>();
  const edgeKey = (a: number, b: number) =>
    a < b ? `${a}-${b}` : `${b}-${a}`;

  const orientedEdge = (a: number, b: number): string => {
    const key = edgeKey(a, b);
    const forward = a < b;
    let curve = edgeCurves.get(key);
    if (curve === undefined) {
      const [from, to] = forward ? [a, b] : [b, a];
      const start = corners[from]!;
      const end = corners[to]!;
      const span = {
        x: end.x - start.x,
        y: end.y - start.y,
        z: end.z - start.z
      };
      const length = Math.hypot(span.x, span.y, span.z);
      const origin = writer.point(start);
      const direction = writer.direction({
        x: span.x / length,
        y: span.y / length,
        z: span.z / length
      });
      const vector = writer.add(`VECTOR('',${direction},${real(length)})`);
      const line = writer.add(`LINE('',${origin},${vector})`);
      curve = writer.add(
        `EDGE_CURVE('',${vertices[from]},${vertices[to]},${line},.T.)`
      );
      edgeCurves.set(key, curve);
    }
    return writer.add(
      `ORIENTED_EDGE('',*,*,${curve},${forward ? '.T.' : '.F.'})`
    );
  };

  const faces = BOX_FACES.map((face) => {
    const edges = face.loop.map((corner, index) =>
      orientedEdge(corner, face.loop[(index + 1) % face.loop.length]!)
    );
    const loop = writer.add(`EDGE_LOOP('',(${edges.join(',')}))`);
    const bound = writer.add(`FACE_OUTER_BOUND('',${loop},.T.)`);
    const plane = writer.add(
      `PLANE('',${writer.placement(corners[face.origin]!, face.normal, face.ref)})`
    );
    return writer.add(`ADVANCED_FACE('${label} ${face.label}',(${bound}),${plane},.T.)`);
  });

  return writer.add(`CLOSED_SHELL('${label}',(${faces.join(',')}))`);
}

function writeUnits(
  writer: EntityWriter,
  context: StepContextSpec
): { unitIds: string[]; uncertainty: string } {
  const millimetre = writer.add(
    `( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) )`
  );
  const radian = writer.add(
    `( NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.) )`
  );
  const steradian = writer.add(
    `( NAMED_UNIT(*) SI_UNIT($,.STERADIAN.) SOLID_ANGLE_UNIT() )`
  );

  let lengthUnit = millimetre;
  if (context.length.kind === 'conversion') {
    writer.comment(
      `length unit is ${context.length.name}: every coordinate below is in ` +
        `${context.length.name}, scale by ${real(context.length.factorMm)} for mm`
    );
    const measure = writer.add(
      `LENGTH_MEASURE_WITH_UNIT(LENGTH_MEASURE(${real(context.length.factorMm)}),${millimetre})`
    );
    lengthUnit = writer.add(
      `( CONVERSION_BASED_UNIT('${context.length.name}',${measure}) LENGTH_UNIT() NAMED_UNIT(*) )`
    );
  }

  let angleUnit = radian;
  if (context.angle.kind === 'conversion') {
    writer.comment(
      `plane-angle unit is ${context.angle.name}: angle-typed parameters below ` +
        `are in ${context.angle.name}, scale by ${real(context.angle.factorRadians)} for radians`
    );
    const measure = writer.add(
      `PLANE_ANGLE_MEASURE_WITH_UNIT(PLANE_ANGLE_MEASURE(${real(context.angle.factorRadians)}),${radian})`
    );
    angleUnit = writer.add(
      `( CONVERSION_BASED_UNIT('${context.angle.name}',${measure}) NAMED_UNIT(*) PLANE_ANGLE_UNIT() )`
    );
  }

  const uncertainty = writer.add(
    `UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-07),${lengthUnit},` +
      `'distance_accuracy_value','confusion accuracy')`
  );
  return { unitIds: [lengthUnit, angleUnit, steradian], uncertainty };
}

export interface StepFileSpec {
  /** Written into FILE_NAME — the corpus id, so a stray file identifies itself. */
  id: string;
  /** Written into FILE_DESCRIPTION — what this file is testing, in one line. */
  purpose: string;
  context?: StepContextSpec;
  /** Solids, each an outer box with optional cavity boxes inside it. */
  solids: Array<{
    name: string;
    outer: BoxSpec;
    /** Inner shells, emitted through `BREP_WITH_VOIDS`. */
    voids?: BoxSpec[];
  }>;
}

/**
 * Write a complete AP214 part-21 file for the given boxes.
 *
 * `voids` is the point of this writer existing: a solid with inner shells is
 * emitted as `BREP_WITH_VOIDS` over `ORIENTED_CLOSED_SHELL(...,.F.)`, which no
 * OpenZCAD exporter produces today.
 */
export function writeBoxStepFile(spec: StepFileSpec): string {
  const context = spec.context ?? MILLIMETRE_CONTEXT;
  const writer = new EntityWriter();

  writer.lines.push(
    `/* corpus: ${spec.id}\n${spec.purpose
      .replace(/(.{1,70})(\s|$)/g, '   $1\n')
      .trimEnd()} */`
  );
  const { unitIds, uncertainty } = writeUnits(writer, context);

  let representationContext: string;
  if (context.assignUnits) {
    representationContext = writer.add(
      `( GEOMETRIC_REPRESENTATION_CONTEXT(3) ` +
        `GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((${uncertainty})) ` +
        `GLOBAL_UNIT_ASSIGNED_CONTEXT((${unitIds.join(',')})) ` +
        `REPRESENTATION_CONTEXT('Context3D','3D Context with UNIT and UNCERTAINTY') )`
    );
  } else {
    writer.comment(
      'no GLOBAL_UNIT_ASSIGNED_CONTEXT: the units above are declared but never ' +
        'bound to the representation context, so no reader can prove a scale'
    );
    representationContext = writer.add(
      `( GEOMETRIC_REPRESENTATION_CONTEXT(3) ` +
        `REPRESENTATION_CONTEXT('Context3D','3D Context without UNIT') )`
    );
  }

  const applicationContext = writer.add(
    `APPLICATION_CONTEXT('core data for automotive mechanical design processes')`
  );
  writer.add(
    `APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2010,${applicationContext})`
  );
  const productContext = writer.add(
    `PRODUCT_CONTEXT('',${applicationContext},'mechanical')`
  );
  const product = writer.add(
    `PRODUCT('${spec.id}','${spec.id}','',(${productContext}))`
  );
  const formation = writer.add(`PRODUCT_DEFINITION_FORMATION('','',${product})`);
  const definitionContext = writer.add(
    `PRODUCT_DEFINITION_CONTEXT('part definition',${applicationContext},'design')`
  );
  const definition = writer.add(
    `PRODUCT_DEFINITION('design','',${formation},${definitionContext})`
  );
  const definitionShape = writer.add(
    `PRODUCT_DEFINITION_SHAPE('','',${definition})`
  );
  writer.add(`PRODUCT_RELATED_PRODUCT_CATEGORY('part','',(${product}))`);

  const origin = writer.placement(
    { x: 0, y: 0, z: 0 },
    { x: 0, y: 0, z: 1 },
    { x: 1, y: 0, z: 0 }
  );

  const solids = spec.solids.map((solid) => {
    const outer = writeBoxShell(writer, solid.outer, solid.name);
    if (!solid.voids || solid.voids.length === 0) {
      return writer.add(`MANIFOLD_SOLID_BREP('${solid.name}',${outer})`);
    }
    writer.comment(
      `${solid.name}: ${solid.voids.length} enclosed ` +
        `${solid.voids.length === 1 ? 'cavity' : 'cavities'} via BREP_WITH_VOIDS`
    );
    const voids = solid.voids.map((cavity, index) => {
      const shell = writeBoxShell(writer, cavity, `${solid.name} void ${index + 1}`);
      // .F. flips the outward-built shell so its normals face the material.
      return writer.add(`ORIENTED_CLOSED_SHELL('',*,${shell},.F.)`);
    });
    return writer.add(
      `BREP_WITH_VOIDS('${solid.name}',${outer},(${voids.join(',')}))`
    );
  });

  const representation = writer.add(
    `ADVANCED_BREP_SHAPE_REPRESENTATION('${spec.id}',(${origin},${solids.join(',')}),${representationContext})`
  );
  writer.add(
    `SHAPE_DEFINITION_REPRESENTATION(${definitionShape},${representation})`
  );

  return [
    'ISO-10303-21;',
    'HEADER;',
    `FILE_DESCRIPTION(('${escapeStepString(spec.purpose)}'),'2;1');`,
    `FILE_NAME('${spec.id}.step','2026-01-01T00:00:00',('OpenZCAD parity corpus'),` +
      `('OpenZCAD'),'OpenZCAD parity corpus authoring','OpenZCAD','');`,
    "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));",
    'ENDSEC;',
    'DATA;',
    ...writer.lines,
    'ENDSEC;',
    'END-ISO-10303-21;',
    ''
  ].join('\n');
}

function escapeStepString(text: string): string {
  return text.replace(/'/g, "''");
}

/** Volume of a box, for asserting hand-authored expectations without a kernel. */
export function boxVolume(box: BoxSpec): number {
  return (
    (box.max.x - box.min.x) *
    (box.max.y - box.min.y) *
    (box.max.z - box.min.z)
  );
}

const DEGREES_IN_RADIAN = 180 / Math.PI;

/**
 * Rewrite a radian-context STEP file so plane angles are declared and written
 * in degrees.
 *
 * Lifted from `test/step-import-compat.test.ts`'s `declareDegrees`, which is
 * where this case was first pinned. BrepKit used to read `CONICAL_SURFACE`
 * half-angles as radians regardless of the declared unit, so the adapter
 * rewrote the transient kernel input in JavaScript. K0.1 taught the kernel to
 * read the declared unit and Z3 deleted the rewriter; this file is what made
 * that deletion measurable rather than assumed.
 */
export function declareDegreePlaneAngles(step: string): string {
  const radianUnit =
    /#(\d+)\s*=\s*\([^;]*PLANE_ANGLE_UNIT\s*\(\s*\)[^;]*SI_UNIT\s*\(\s*\$\s*,\s*\.RADIAN\.\s*\)[^;]*\);/i.exec(
      step
    ) ??
    /#(\d+)\s*=\s*\([^;]*SI_UNIT\s*\(\s*\$\s*,\s*\.RADIAN\.\s*\)[^;]*PLANE_ANGLE_UNIT\s*\(\s*\)[^;]*\);/i.exec(
      step
    );
  if (!radianUnit) {
    throw new Error('source STEP declares no SI radian plane-angle unit');
  }
  const factorId = 900_001;
  const baseId = 900_002;

  const degrees = step
    .replace(
      radianUnit[0],
      `#${radianUnit[1]} = ( CONVERSION_BASED_UNIT('DEGREE',#${factorId}) NAMED_UNIT(*) PLANE_ANGLE_UNIT() );`
    )
    .replace(
      /(CONICAL_SURFACE\s*\([^;]*,\s*)([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:E[+-]?\d+)?)(\s*\)\s*;)/gi,
      (_entity, prefix: string, angle: string, suffix: string) =>
        `${prefix}${(Number(angle) * DEGREES_IN_RADIAN).toPrecision(17)}${suffix}`
    );

  return degrees.replace(
    /\nENDSEC;\s*\nEND-ISO-10303-21;/,
    `\n#${factorId} = PLANE_ANGLE_MEASURE_WITH_UNIT(PLANE_ANGLE_MEASURE(${1 / DEGREES_IN_RADIAN}),#${baseId});` +
      `\n#${baseId} = ( NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.) );` +
      '\nENDSEC;\nEND-ISO-10303-21;'
  );
}

/**
 * Strip `GLOBAL_UNIT_ASSIGNED_CONTEXT` (and the uncertainty context that
 * references the same units) out of an exported file, leaving a representation
 * context that binds no units at all. The unit entities themselves stay in the
 * file — they are simply orphaned, which is the interesting shape: a reader
 * can see a DEGREE unit declared and still cannot prove it applies.
 */
export function stripGlobalUnitContext(step: string): string {
  const stripped = step
    .replace(/GLOBAL_UNIT_ASSIGNED_CONTEXT\s*\(\s*\([^)]*\)\s*\)\s*/gi, '')
    .replace(
      /GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT\s*\(\s*\([^)]*\)\s*\)\s*/gi,
      ''
    );
  if (/GLOBAL_UNIT_ASSIGNED_CONTEXT/i.test(stripped)) {
    throw new Error('GLOBAL_UNIT_ASSIGNED_CONTEXT survived the strip');
  }
  if (stripped === step) {
    throw new Error('source STEP declared no GLOBAL_UNIT_ASSIGNED_CONTEXT');
  }
  return stripped;
}
