/**
 * What an exported STEP file says about itself and its bodies.
 *
 * The paired writer emits exact geometry under an AP203 product called
 * `remus_solid`, a placeholder header and no presentation. Its options carry
 * the product name, file name and timestamp; everything else is finished
 * here, on its text: the file is restated as AP214 (the protocol that can
 * carry colour), each solid takes its body's name, each body's display
 * colour is written as a surface style, and every real is written in its
 * shortest exact form.
 *
 * Like the unit declaration beside it, every edit matches the writer's one
 * known form of the entity it changes and refuses anything else, so a changed
 * writer fails an export loudly instead of shipping a half-converted file.
 */

import type { BodyId, StepProtocol } from '@openzcad/shared';

import type { ExportUnitOptions } from './export-units';

/** A STEP export's unit plus the header's file name and time stamp. */
export interface StepExportOptions extends ExportUnitOptions {
  /** The name the file is saved under; the document name when unset. */
  fileName?: string;
  /** ISO 8601 time stamp for the header; the time of export when unset. */
  timestamp?: string;
  /** The application protocol the file states; AP214 when unset. */
  protocol?: StepProtocol;
}

/** Why a body was left out of a whole-document STEP. */
export type StepBodySkipReason =
  /** Its history step failed, so it has no geometry to write. */
  | 'failed'
  /** A mesh too large to convert, kept only as a reference. */
  | 'mesh-reference'
  /** The build left it with no solid. */
  | 'empty';

/** A whole-document STEP and how its declared solids map to bodies. */
export interface StepBodiesExport {
  text: string;
  /** Every written body in file order, with the solids it declared. */
  bodies: { bodyId: BodyId; solidCount: number }[];
  /** Shown bodies that had nothing to write. */
  skipped: { bodyId: BodyId; reason: StepBodySkipReason }[];
}

/** One exported solid's label, in the order the writer receives solids. */
export interface StepSolidLabel {
  /** The body's name. */
  name: string;
  /** The body's display colour, `#rrggbb`. */
  color: string;
}

export interface StepExportMetadata {
  /** The product: what a receiving CAD shows as the part's name. */
  productName: string;
  /** The file name the export is saved under. */
  fileName: string;
  /** When the file was written, ISO 8601. */
  timestamp: string;
  /** One label per solid, in writer order. */
  solids: readonly StepSolidLabel[];
  /** The application protocol the file states; AP214 when unset. */
  protocol?: StepProtocol;
  /**
   * I02: the Objects folders to write as an assembly. Absent, or with no
   * folder, the file is one product holding every solid, as before.
   */
  assembly?: StepExportAssembly;
}

/** Objects folders as a STEP product tree (I02). */
export interface StepExportAssembly {
  /** Folders, parents before children; `parent` indexes this list. */
  folders: readonly { name: string; parent: number | null }[];
  /**
   * The written bodies in writer order: each takes `solidCount` consecutive
   * solids of {@link StepExportMetadata.solids} and sits in `folder` (an
   * index into `folders`) or at the top level.
   */
  bodies: readonly {
    name: string;
    solidCount: number;
    folder: number | null;
  }[];
}

/**
 * What each protocol states in the header and its application context.
 * The two share every entity the export writes — product structure,
 * exact geometry, `STYLED_ITEM` presentation — so the protocol changes
 * these three statements and nothing else. AP242 is stated as edition 1
 * (ISO 10303-242:2014), the long-form schema receivers read as AP242.
 */
const STEP_PROTOCOL_STATEMENTS: Record<
  StepProtocol,
  { schema: string; context: string; protocol: string; year: number }
> = {
  ap214: {
    schema: 'AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }',
    context: 'core data for automotive mechanical design processes',
    protocol: 'automotive_design',
    year: 2000
  },
  ap242: {
    schema:
      'AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF { 1 0 10303 442 1 1 4 }',
    context: 'managed model based 3d engineering',
    protocol: 'ap242_managed_model_based_3d_engineering',
    year: 2014
  }
};

/** The header fields the writer takes itself, as its options JSON. */
export function stepWriterOptions(metadata: StepExportMetadata): string {
  return JSON.stringify({
    productName: metadata.productName,
    fileName: metadata.fileName,
    timestamp: metadata.timestamp
  });
}

/** A Part 21 time stamp: UTC to the second, so no local zone is disclosed. */
export function stepTimestamp(date: Date): string {
  return `${date.toISOString().slice(0, 19)}Z`;
}

/**
 * Quotes `value` as a Part 21 string literal. The header declares edition 2
 * (`'2;1'`), whose strings hold printable ASCII only: an apostrophe and a
 * backslash double, any other character goes in a `\X2\`…`\X0\` run of
 * UTF-16 code units, or a `\X4\`…`\X0\` run for code points beyond the
 * Basic Multilingual Plane — the encoding the paired writer and reader use.
 */
export function stepStringLiteral(value: string): string {
  let out = "'";
  let run: 'ascii' | 'x2' | 'x4' = 'ascii';
  const close = () => {
    if (run !== 'ascii') out += '\\X0\\';
    run = 'ascii';
  };
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code >= 0x20 && code <= 0x7e) {
      close();
      out += character === "'" ? "''" : character === '\\' ? '\\\\' : character;
    } else if (code > 0xffff) {
      if (run !== 'x4') {
        close();
        out += '\\X4\\';
        run = 'x4';
      }
      out += code.toString(16).toUpperCase().padStart(8, '0');
    } else {
      if (run !== 'x2') {
        close();
        out += '\\X2\\';
        run = 'x2';
      }
      out += code.toString(16).toUpperCase().padStart(4, '0');
    }
  }
  close();
  return `${out}'`;
}

/** A real in its shortest exact Part 21 form: `26.7`, `0.`, `1.E-7`. */
export function formatStepReal(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error(`STEP export produced a non-finite number (${value}).`);
  }
  if (value === 0) return '0.';
  const [mantissa, exponent] = String(value).split('e');
  const withPoint = mantissa!.includes('.') ? mantissa! : `${mantissa}.`;
  return exponent === undefined
    ? withPoint
    : `${withPoint}E${exponent.replace('+', '')}`;
}

/**
 * Coordinates and direction components smaller than this are rounding
 * residue of a zero (a cosine of π/2 is 6e-17, not 0) and are written as
 * zero. It sits five orders of magnitude under any length tolerance the
 * writer declares, so no position or direction moves measurably.
 */
export const STEP_ZERO_RESIDUE = 1e-12;

const STRING_LITERAL = /'(?:[^']|'')*'/g;
const REAL = /(?<![\w#.$])[+-]?\d+\.\d*(?:[eE][+-]?\d+)?(?![\w.])/g;
const ENTITY_LINE = /^#(\d+)\s*=\s*([A-Z][A-Z0-9_]*)\(/;
const ENTITY_ID = /^#(\d+)\s*=/;
/** A written entity line: its id and everything after `= `. */
const ENTITY_TEXT = /^#(\d+) = (.*);$/;
const SOLID_ENTITY =
  /^(#\d+) = (MANIFOLD_SOLID_BREP|BREP_WITH_VOIDS)\('(?:[^']|'')*', /;
const SNAPPED_ENTITIES = new Set(['CARTESIAN_POINT', 'DIRECTION']);

/** Rewrites every real outside string literals in one entity line. */
function normalizeRealsInLine(line: string): string {
  const snap = SNAPPED_ENTITIES.has(ENTITY_LINE.exec(line)?.[2] ?? '');
  const rewrite = (segment: string) =>
    segment.replace(REAL, (literal) => {
      const value = Number(literal);
      return formatStepReal(
        snap && Math.abs(value) < STEP_ZERO_RESIDUE ? 0 : value
      );
    });
  let out = '';
  let last = 0;
  for (const match of line.matchAll(STRING_LITERAL)) {
    out += rewrite(line.slice(last, match.index)) + match[0];
    last = match.index + match[0].length;
  }
  return out + rewrite(line.slice(last));
}

/** Replaces the one line `pattern` matches, or refuses the export. */
function replaceOnly(
  lines: string[],
  pattern: RegExp,
  what: string,
  replace: (match: RegExpExecArray) => string
): RegExpExecArray {
  let found: { index: number; match: RegExpExecArray } | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const match = pattern.exec(lines[index]!);
    if (!match) continue;
    if (found) {
      throw new Error(`The STEP writer wrote ${what} twice; export refused.`);
    }
    found = { index, match };
  }
  if (!found) {
    throw new Error(
      `The STEP writer's ${what} was not in its known form; export refused.`
    );
  }
  lines[found.index] = replace(found.match);
  return found.match;
}

const HEX_COLOR = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;

/** `#rrggbb` as Part 21 `COLOUR_RGB` channels in [0, 1]. */
function colourChannels(color: string): string {
  const match = HEX_COLOR.exec(color);
  if (!match) {
    throw new Error(`Body colour "${color}" is not #rrggbb; export refused.`);
  }
  return match
    .slice(1)
    .map((hex) => formatStepReal(Number.parseInt(hex, 16) / 255))
    .join(',');
}

type StepProductRef = {
  definition: string;
  representation: string;
  frame: string;
};

/**
 * I02: restates the one-product file as an assembly. The root product keeps
 * the document's name over a placement-only shape; every folder becomes a
 * geometry-free sub-assembly and every body a part whose shape holds its
 * solids, each placed in its parent by an identity
 * `ITEM_DEFINED_TRANSFORMATION` between two distinct frames (schema order:
 * the component's frame, then the assembly's). Geometry, solid names and
 * presentation are untouched, so a reader that ignores products still reads
 * the same solids in the same order.
 */
function writeAssembly(
  data: string[],
  entity: (text: string) => string,
  assembly: StepExportAssembly,
  breps: readonly string[],
  representation: RegExpExecArray
): void {
  const total = assembly.bodies.reduce((sum, body) => sum + body.solidCount, 0);
  if (total !== breps.length) {
    throw new Error(
      `The STEP assembly names ${total} solids for ${breps.length} written; export refused.`
    );
  }
  const definition = replaceOnly(
    data,
    /^#(\d+) = PRODUCT_DEFINITION\('design', '', #\d+, #(\d+)\);$/,
    'product definition',
    (match) => match[0]
  );
  const productContext = replaceOnly(
    data,
    /^#(\d+) = PRODUCT_CONTEXT\('', #\d+, 'mechanical'\);$/,
    'product context',
    (match) => match[0]
  );
  // ISO 10303-43: the two sides of a transformed relationship have their
  // own contexts. Each new shape takes a copy of the writer's (same units
  // and uncertainty).
  const contextText = data
    .map((line) => ENTITY_TEXT.exec(line))
    .find((match) => match?.[1] === representation[4])?.[2];
  if (!contextText?.includes('GEOMETRIC_REPRESENTATION_CONTEXT')) {
    throw new Error(
      "The STEP writer's representation context was not in its known form; export refused."
    );
  }
  const origin = entity("CARTESIAN_POINT('', (0., 0., 0.))");
  const z = entity("DIRECTION('', (0., 0., 1.))");
  const x = entity("DIRECTION('', (1., 0., 0.))");
  const frame = () => entity(`AXIS2_PLACEMENT_3D('', ${origin}, ${z}, ${x})`);
  // The root keeps the document's product over a placement-only shape.
  const rootFrame = frame();
  const rootShape = replaceOnly(
    data,
    /^(#\d+) = ADVANCED_BREP_SHAPE_REPRESENTATION\(('(?:[^']|'')*'), \((#\d+(?:, #\d+)*)\), (#\d+)\);$/,
    'shape representation',
    (match) =>
      `${match[1]} = SHAPE_REPRESENTATION(${match[2]}, (${rootFrame}), ${match[4]});`
  );
  const root: StepProductRef = {
    definition: `#${definition[1]}`,
    representation: rootShape[1]!,
    frame: rootFrame
  };
  const product = (
    name: string,
    category: 'part' | 'assembly',
    items: readonly string[]
  ): StepProductRef => {
    const literal = stepStringLiteral(name);
    const id = entity(
      `PRODUCT(${literal}, ${literal}, '', (#${productContext[1]}))`
    );
    entity(`PRODUCT_RELATED_PRODUCT_CATEGORY('${category}', $, (${id}))`);
    const formation = entity(`PRODUCT_DEFINITION_FORMATION('', '', ${id})`);
    const definitionId = entity(
      `PRODUCT_DEFINITION('design', '', ${formation}, #${definition[2]})`
    );
    const shape = entity(`PRODUCT_DEFINITION_SHAPE('', '', ${definitionId})`);
    const placement = frame();
    const kind =
      category === 'part'
        ? 'ADVANCED_BREP_SHAPE_REPRESENTATION'
        : 'SHAPE_REPRESENTATION';
    const context = entity(contextText);
    const shapeRepresentation = entity(
      `${kind}(${literal}, (${[...items, placement].join(', ')}), ${context})`
    );
    entity(`SHAPE_DEFINITION_REPRESENTATION(${shape}, ${shapeRepresentation})`);
    return {
      definition: definitionId,
      representation: shapeRepresentation,
      frame: placement
    };
  };
  let occurrences = 0;
  const place = (
    child: StepProductRef,
    parent: StepProductRef,
    name: string
  ) => {
    occurrences += 1;
    const usage = entity(
      `NEXT_ASSEMBLY_USAGE_OCCURRENCE('${occurrences}', ${stepStringLiteral(name)}, '', ${parent.definition}, ${child.definition}, $)`
    );
    const shape = entity(`PRODUCT_DEFINITION_SHAPE('', '', ${usage})`);
    const transformation = entity(
      `ITEM_DEFINED_TRANSFORMATION('', '', ${child.frame}, ${parent.frame})`
    );
    const relation = entity(
      `( REPRESENTATION_RELATIONSHIP('', '', ${child.representation}, ${parent.representation}) REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION(${transformation}) SHAPE_REPRESENTATION_RELATIONSHIP() )`
    );
    entity(`CONTEXT_DEPENDENT_SHAPE_REPRESENTATION(${relation}, ${shape})`);
  };
  const folders: StepProductRef[] = [];
  for (const folder of assembly.folders) {
    const made = product(folder.name, 'assembly', []);
    folders.push(made);
    place(
      made,
      folder.parent === null ? root : folders[folder.parent]!,
      folder.name
    );
  }
  let next = 0;
  for (const body of assembly.bodies) {
    const solids = breps.slice(next, next + body.solidCount);
    next += body.solidCount;
    const made = product(body.name, 'part', solids);
    place(made, body.folder === null ? root : folders[body.folder]!, body.name);
  }
}

/**
 * Finishes the writer's STEP text: AP214 (or AP242) product structure, the
 * OpenZCAD header, solid names, surface colours and normalized reals. `step` is the
 * writer's output for exactly `metadata.solids.length` solids, already
 * given `metadata`'s header fields through {@link stepWriterOptions}.
 */
export function finishStepExport(
  step: string,
  metadata: StepExportMetadata
): string {
  const dataStart = step.indexOf('\nDATA;\n');
  const dataEnd = step.lastIndexOf('\nENDSEC;\nEND-ISO-10303-21;');
  if (dataStart < 0 || dataEnd < dataStart) {
    throw new Error(
      'The STEP writer produced no DATA section; export refused.'
    );
  }
  const statements = STEP_PROTOCOL_STATEMENTS[metadata.protocol ?? 'ap214'];
  const header = step.slice(0, dataStart).split('\n');
  replaceOnly(
    header,
    /^FILE_DESCRIPTION\(\('remus STEP export'\), '2;1'\);$/,
    'file description',
    () => "FILE_DESCRIPTION(('OpenZCAD STEP export'), '2;1');"
  );
  replaceOnly(
    header,
    /^(FILE_NAME\(.*, \(''\), \(''\), )'remus', 'remus', ''\);$/,
    'file name record',
    (match) => `${match[1]}'Remus', 'OpenZCAD', '');`
  );
  replaceOnly(
    header,
    /^FILE_SCHEMA\(\('CONFIG_CONTROL_DESIGN'\)\);$/,
    'schema',
    () => `FILE_SCHEMA(('${statements.schema}'));`
  );

  const data = step
    .slice(dataStart + '\nDATA;\n'.length, dataEnd)
    .split('\n')
    .map(normalizeRealsInLine);
  replaceOnly(
    data,
    /^(#\d+ = APPLICATION_CONTEXT\()'configuration controlled 3D design of mechanical parts and assemblies'\);$/,
    'application context',
    (match) => `${match[1]}'${statements.context}');`
  );
  replaceOnly(
    data,
    /^(#\d+) = MECHANICAL_CONTEXT\(('', #\d+, 'mechanical'\);)$/,
    'product context',
    (match) => `${match[1]} = PRODUCT_CONTEXT(${match[2]}`
  );
  replaceOnly(
    data,
    /^(#\d+ = APPLICATION_PROTOCOL_DEFINITION\('international standard', )'config_control_design', 1994(, #\d+\);)$/,
    'application protocol',
    (match) =>
      `${match[1]}'${statements.protocol}', ${statements.year}${match[2]}`
  );
  const product = replaceOnly(
    data,
    /^#(\d+) = PRODUCT\(.*\);$/,
    'product',
    (match) => match[0]
  );
  const representation = replaceOnly(
    data,
    /^(#\d+ = ADVANCED_BREP_SHAPE_REPRESENTATION\()'remus export'(, \((#\d+(?:, #\d+)*)\), #(\d+)\);)$/,
    'shape representation',
    (match) =>
      `${match[1]}${stepStringLiteral(metadata.productName)}${match[2]}`
  );

  // A solid read from a STEP file keeps the name it was imported with; the
  // body's name, what the user sees, replaces it.
  const breps: string[] = [];
  for (let index = 0; index < data.length; index += 1) {
    const solid = SOLID_ENTITY.exec(data[index]!);
    if (!solid) continue;
    const label = metadata.solids[breps.length];
    if (!label) {
      throw new Error(
        `The STEP writer wrote more than ${metadata.solids.length} solids; export refused.`
      );
    }
    breps.push(solid[1]!);
    data[index] =
      `${solid[1]} = ${solid[2]}(${stepStringLiteral(label.name)}, ${data[index]!.slice(solid[0].length)}`;
  }
  const items = representation[3]!.split(', ');
  if (
    breps.length !== metadata.solids.length ||
    items.join() !== breps.join()
  ) {
    throw new Error(
      `The STEP writer wrote ${breps.length} solids for ${metadata.solids.length} bodies' solids; export refused.`
    );
  }

  // Complex entities (`#1 = ( LENGTH_UNIT() … )`) count too: an inch
  // declaration appends its unit entities with the highest ids.
  let next =
    Math.max(...data.map((line) => Number(ENTITY_ID.exec(line)?.[1] ?? 0))) + 1;
  const appended: string[] = [];
  const entity = (text: string) => {
    const id = `#${next++}`;
    appended.push(`${id} = ${text};`);
    return id;
  };
  entity(`PRODUCT_RELATED_PRODUCT_CATEGORY('part', $, (#${product[1]}))`);
  // One style chain per distinct colour, shared by every solid wearing it.
  const styles = new Map<string, string>();
  const styled = metadata.solids.map((label, index) => {
    const color = label.color.toLowerCase();
    let style = styles.get(color);
    if (!style) {
      const rgb = entity(`COLOUR_RGB('', ${colourChannels(color)})`);
      const fill = entity(`FILL_AREA_STYLE_COLOUR('', ${rgb})`);
      const area = entity(`FILL_AREA_STYLE('', (${fill}))`);
      const surface = entity(`SURFACE_STYLE_FILL_AREA(${area})`);
      const side = entity(`SURFACE_SIDE_STYLE('', (${surface}))`);
      const usage = entity(`SURFACE_STYLE_USAGE(.BOTH., ${side})`);
      style = entity(`PRESENTATION_STYLE_ASSIGNMENT((${usage}))`);
      styles.set(color, style);
    }
    return entity(`STYLED_ITEM('', (${style}), ${breps[index]})`);
  });
  entity(
    `MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION('', (${styled.join(', ')}), #${representation[4]})`
  );
  if (metadata.assembly && metadata.assembly.folders.length > 0) {
    writeAssembly(data, entity, metadata.assembly, breps, representation);
  }

  return [
    header.join('\n'),
    'DATA;',
    ...data,
    ...appended,
    'ENDSEC;',
    'END-ISO-10303-21;',
    ''
  ].join('\n');
}
