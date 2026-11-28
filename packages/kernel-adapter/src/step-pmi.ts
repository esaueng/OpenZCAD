/**
 * D07 slice D: the model's PMI written as STEP AP242 semantic PMI, the
 * representation a receiving system reads as tolerancing rather than as
 * pictures of it (CAx-IF Recommended Practices for the Representation and
 * Presentation of PMI, semantic representation).
 *
 * Every entry is tied to its face: the exact `ADVANCED_FACE` the writer
 * emitted for it, found by the face's index in its solid's shell (the order
 * the kernel lists the solid's faces, which is the order the writer walks
 * them) and checked against the face's surface type. A shell whose face
 * count or a face whose surface differs from the kernel's means the writer
 * changed, and the export is refused rather than tying a tolerance to the
 * wrong face.
 *
 * - A datum feature is a `DATUM_FEATURE` on its face, related by a
 *   `SHAPE_ASPECT_RELATIONSHIP` to the `DATUM` it establishes (its letter).
 * - A frame is the characteristic's tolerance entity on a `SHAPE_ASPECT` of
 *   its face, its magnitude a `LENGTH_MEASURE_WITH_UNIT` in the file's
 *   length unit; datum references are a `DATUM_SYSTEM` of
 *   `DATUM_REFERENCE_COMPARTMENT`s in precedence order, material
 *   conditions are modifiers, and a cylindrical zone is a
 *   `TOLERANCE_ZONE` of form 'cylindrical or circular'.
 */

import {
  modelPmiSurfaceError,
  modelPmiSurfaceUnverified,
  type DrawingGeometricCharacteristic,
  type DrawingMaterialCondition
} from '@openzcad/shared';
import { formatStepReal } from './step-export-metadata';

/** A face as the export found it: its solid in writer order, its index. */
export interface StepPmiFace {
  /** Index into the solids the writer received, in order. */
  solid: number;
  /** The face's index in its solid's face list (= its shell order). */
  face: number;
  /** The kernel's surface type of the face: 'plane', 'cylinder', …. */
  surface: string;
}

export type StepPmiEntry =
  | { kind: 'datum'; letter: string; face: StepPmiFace; name?: string }
  | {
      kind: 'frame';
      /** What the workspace calls the entry, for export feedback. */
      name?: string;
      characteristic: DrawingGeometricCharacteristic;
      /** The zone's size in the file's length unit. */
      amount: number;
      diameterZone: boolean;
      material?: DrawingMaterialCondition;
      datums: { letter: string; material?: DrawingMaterialCondition }[];
      face: StepPmiFace;
    };

/** A model PMI entry the file leaves out, and why (#2258). */
export interface StepPmiOmission {
  /** What the workspace calls it: "Position | 0.1 | A | C | B". */
  name: string;
  /** Why, as a clause with no full stop: "its secondary datum C is …". */
  reason: string;
}

const SLOTS = ['primary', 'secondary', 'tertiary'];

/**
 * #2258/#2321: the entries an AP242 file can carry as semantic PMI, and
 * every other one with its reason, so an export never drops PMI without
 * saying so. A frame is left out when its characteristic cannot control its
 * face's surface (cylindricity on a plane), or when a datum it names is not
 * declared on the model, not written to this file, or on another part
 * (`partOf`: each solid's part, by writer order; `partNames` names them).
 * `declared` holds the datum letters the model declares. A form tolerance
 * kept on a face whose class is not analytic (a B-spline face) is written,
 * since nothing shows it cannot control that face, and listed in
 * `unverified` ("face type not verified: Cylindricity on a freeform face").
 */
export function planStepPmi(
  entries: readonly StepPmiEntry[],
  partOf: readonly number[],
  partNames: readonly string[],
  declared: ReadonlySet<string>
): {
  entries: StepPmiEntry[];
  omitted: StepPmiOmission[];
  unverified: string[];
} {
  const datumPart = new Map<string, number>();
  for (const entry of entries)
    if (entry.kind === 'datum')
      datumPart.set(entry.letter, partOf[entry.face.solid] ?? -1);
  const kept: StepPmiEntry[] = [];
  const omitted: StepPmiOmission[] = [];
  const unverified: string[] = [];
  for (const entry of entries) {
    if (entry.kind === 'datum') {
      kept.push(entry);
      continue;
    }
    const name = entry.name ?? entry.characteristic;
    const surface = modelPmiSurfaceError(
      entry.characteristic,
      entry.face.surface,
      entry.face.support
    );
    if (surface) {
      omitted.push({ name, reason: surface.replace(/\.$/, '') });
      continue;
    }
    const part = partOf[entry.face.solid] ?? -1;
    const problem = entry.datums
      .map((reference, slot) => {
        const which = `its ${SLOTS[slot] ?? ''} datum ${reference.letter}`;
        if (!declared.has(reference.letter))
          return `${which} is not declared on the model`;
        const at = datumPart.get(reference.letter);
        if (at === undefined)
          return `${which} is on a face or body this file does not write`;
        if (at !== part)
          return `${which} is on ${partNames[at] ?? 'another body'}, which this file writes as a separate part`;
        return null;
      })
      .find((reason) => reason !== null);
    if (problem) {
      omitted.push({ name, reason: problem });
      continue;
    }
    kept.push(entry);
    const unchecked = modelPmiSurfaceUnverified(
      entry.characteristic,
      entry.face.surface
    );
    if (unchecked) unverified.push(unchecked);
  }
  return { entries: kept, omitted, unverified };
}

/** The tolerance entity each characteristic is written as. */
const TOLERANCE_ENTITY: Readonly<
  Record<DrawingGeometricCharacteristic, string>
> = {
  straightness: 'STRAIGHTNESS_TOLERANCE',
  flatness: 'FLATNESS_TOLERANCE',
  circularity: 'ROUNDNESS_TOLERANCE',
  cylindricity: 'CYLINDRICITY_TOLERANCE',
  'profile-line': 'LINE_PROFILE_TOLERANCE',
  'profile-surface': 'SURFACE_PROFILE_TOLERANCE',
  parallelism: 'PARALLELISM_TOLERANCE',
  perpendicularity: 'PERPENDICULARITY_TOLERANCE',
  angularity: 'ANGULARITY_TOLERANCE',
  position: 'POSITION_TOLERANCE',
  concentricity: 'CONCENTRICITY_TOLERANCE',
  symmetry: 'SYMMETRY_TOLERANCE',
  'circular-runout': 'CIRCULAR_RUNOUT_TOLERANCE',
  'total-runout': 'TOTAL_RUNOUT_TOLERANCE'
};

/**
 * Tolerance entities that are themselves subtypes of
 * `geometric_tolerance_with_datum_reference`: their datum system is one of
 * their own attributes rather than a further partial entity.
 */
const WITH_DATUM_SUBTYPES = new Set([
  'PARALLELISM_TOLERANCE',
  'PERPENDICULARITY_TOLERANCE',
  'ANGULARITY_TOLERANCE',
  'CONCENTRICITY_TOLERANCE',
  'SYMMETRY_TOLERANCE',
  'CIRCULAR_RUNOUT_TOLERANCE',
  'TOTAL_RUNOUT_TOLERANCE'
]);

const MODIFIER: Readonly<Record<DrawingMaterialCondition, string>> = {
  mmc: '.MAXIMUM_MATERIAL_REQUIREMENT.',
  lmc: '.LEAST_MATERIAL_REQUIREMENT.'
};

/** The surface entity the writer emits for each kernel surface type. */
const SURFACE_ENTITY: Readonly<Record<string, RegExp>> = {
  plane: /^PLANE\(/,
  cylinder: /^CYLINDRICAL_SURFACE\(/,
  cone: /^CONICAL_SURFACE\(/,
  sphere: /^SPHERICAL_SURFACE\(/,
  torus: /^TOROIDAL_SURFACE\(/
};

const LINE = /^#(\d+) = (.*);$/;

/** The entity ids `text` refers to, ignoring any inside string literals. */
function references(text: string): string[] {
  return [...text.replace(/'(?:[^']|'')*'/g, "''").matchAll(/#\d+/g)].map(
    (match) => match[0]
  );
}

/** A STEP string literal: quotes doubled; the text is ASCII by contract. */
function literal(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

/** The product a solid belongs to: its shape and its representation. */
export interface StepPmiPart {
  /** The product's `PRODUCT_DEFINITION_SHAPE` id. */
  productShape: string;
  /** The `ADVANCED_BREP_SHAPE_REPRESENTATION` id holding the solid. */
  representation: string;
}

export interface StepPmiContext {
  /** The written entity lines (`#n = …;`), as finishStepExport holds them. */
  data: readonly string[];
  /** Appends an entity and returns its id. */
  entity: (text: string) => string;
  /** The `MANIFOLD_SOLID_BREP`/`BREP_WITH_VOIDS` ids, in writer order. */
  breps: readonly string[];
  /**
   * Each solid's product, by writer order: the one product of a plain file,
   * or (I02 Objects folders) the part its body became.
   */
  parts: readonly StepPmiPart[];
}

/**
 * Appends `entries` as AP242 semantic PMI. Throws when a face cannot be
 * found exactly as the kernel describes it. A frame naming a datum no entry
 * on its part declares, or on a surface its characteristic cannot control,
 * is left out ({@link planStepPmi} reports those before the file is
 * written); the count of entries written is returned.
 */
export function appendStepPmi(
  context: StepPmiContext,
  entries: readonly StepPmiEntry[]
): number {
  const byId = new Map<string, string>();
  for (const line of context.data) {
    const match = LINE.exec(line);
    if (match) byId.set(`#${match[1]}`, match[2]!);
  }
  const lengthUnit = fileLengthUnit(byId);
  const faceEntity = (face: StepPmiFace): string => {
    const brep = context.breps[face.solid];
    const solid = brep ? byId.get(brep) : undefined;
    const shellId = solid ? references(solid)[0] : undefined;
    const shell = shellId ? byId.get(shellId) : undefined;
    if (!shell || !/^CLOSED_SHELL\(/.test(shell))
      throw new Error(
        'The STEP writer wrote a solid without its closed shell; PMI export refused.'
      );
    const faces = references(shell);
    const id = faces[face.face];
    const advanced = id ? byId.get(id) : undefined;
    if (!advanced || !/^ADVANCED_FACE\(/.test(advanced))
      throw new Error(
        'The STEP writer wrote a shell other than the kernel’s faces; PMI export refused.'
      );
    const expected = SURFACE_ENTITY[face.surface];
    if (expected) {
      const surfaceRefs = references(advanced);
      const surface = byId.get(surfaceRefs[surfaceRefs.length - 1]!);
      if (!surface || !expected.test(surface))
        throw new Error(
          'The STEP writer wrote a face on another surface than the kernel’s; PMI export refused.'
        );
    }
    return id!;
  };
  const { entity } = context;
  const partOf = (face: StepPmiFace): StepPmiPart => {
    const part = context.parts[face.solid];
    if (!part)
      throw new Error('A PMI face names no written part; PMI export refused.');
    return part;
  };
  let written = 0;
  // Datums first: frames refer to them. A datum serves the part it is on:
  // another part's datum is not in its reference frame.
  const datums = new Map<string, string>();
  const systems = new Map<string, string>();
  const key = (part: StepPmiPart, letter: string) =>
    `${part.productShape} ${letter}`;
  for (const entry of entries) {
    if (entry.kind !== 'datum') continue;
    const face = faceEntity(entry.face);
    const { productShape: pds, representation: rep } = partOf(entry.face);
    const feature = entity(
      `DATUM_FEATURE(${literal(`datum feature ${entry.letter}`)}, '', ${pds}, .T.)`
    );
    entity(
      `GEOMETRIC_ITEM_SPECIFIC_USAGE('', '', ${feature}, ${rep}, ${face})`
    );
    const datum = entity(
      `DATUM(${literal(`datum ${entry.letter}`)}, '', ${pds}, .F., ${literal(entry.letter)})`
    );
    entity(`SHAPE_ASPECT_RELATIONSHIP('', $, ${feature}, ${datum})`);
    datums.set(key(partOf(entry.face), entry.letter), datum);
    written += 1;
  }
  for (const entry of entries) {
    if (entry.kind !== 'frame') continue;
    const part = partOf(entry.face);
    if (
      entry.datums.some(
        (reference) => !datums.has(key(part, reference.letter))
      ) ||
      modelPmiSurfaceError(entry.characteristic, entry.face.surface) !== null
    )
      continue;
    const face = faceEntity(entry.face);
    const { productShape: pds, representation: rep } = part;
    const aspect = entity(`SHAPE_ASPECT('toleranced face', '', ${pds}, .T.)`);
    entity(`GEOMETRIC_ITEM_SPECIFIC_USAGE('', '', ${aspect}, ${rep}, ${face})`);
    const magnitude = entity(
      `LENGTH_MEASURE_WITH_UNIT(LENGTH_MEASURE(${formatStepReal(entry.amount)}), ${lengthUnit})`
    );
    let system: string | null = null;
    if (entry.datums.length > 0) {
      // One datum system per distinct reference frame on a part, named by
      // its references ("A|B(M)"): datum_system.UR1 makes (of_shape, name)
      // unique, and frames sharing a reference frame share its system.
      const name = entry.datums
        .map(
          (reference) =>
            `${reference.letter}${reference.material === 'mmc' ? '(M)' : reference.material === 'lmc' ? '(L)' : ''}`
        )
        .join('|');
      const systemKey = `${pds} ${name}`;
      system = systems.get(systemKey) ?? null;
      if (!system) {
        // general_datum_reference.WR2: a compartment has no description.
        const compartments = entry.datums.map((reference) =>
          entity(
            `DATUM_REFERENCE_COMPARTMENT('', $, ${pds}, .F., ${datums.get(key(part, reference.letter))!}, ${
              reference.material
                ? `(SIMPLE_DATUM_REFERENCE_MODIFIER(${MODIFIER[reference.material]}))`
                : '$'
            })`
          )
        );
        system = entity(
          `DATUM_SYSTEM(${literal(name)}, '', ${pds}, .F., (${compartments.join(', ')}))`
        );
        systems.set(systemKey, system);
      }
    }
    const leaf = TOLERANCE_ENTITY[entry.characteristic];
    const name = literal(entry.characteristic.replace(/-/g, ' '));
    const base = `${name}, '', ${magnitude}, ${aspect}`;
    const ownDatums = WITH_DATUM_SUBTYPES.has(leaf);
    const needsComplex =
      entry.material !== undefined || (system !== null && !ownDatums);
    let tolerance: string;
    if (!needsComplex) {
      // One leaf with its supertypes: the internal mapping.
      tolerance = entity(
        ownDatums ? `${leaf}(${base}, (${system!}))` : `${leaf}(${base})`
      );
    } else {
      // Further partial entities: the external mapping, its parts in
      // alphabetical order (ISO 10303-21, 12.2.5.2).
      const parts = new Map<string, string>([
        ['GEOMETRIC_TOLERANCE', `GEOMETRIC_TOLERANCE(${base})`],
        [leaf, `${leaf}()`]
      ]);
      if (system !== null)
        parts.set(
          'GEOMETRIC_TOLERANCE_WITH_DATUM_REFERENCE',
          `GEOMETRIC_TOLERANCE_WITH_DATUM_REFERENCE((${system}))`
        );
      if (entry.material)
        parts.set(
          'GEOMETRIC_TOLERANCE_WITH_MODIFIERS',
          `GEOMETRIC_TOLERANCE_WITH_MODIFIERS((${MODIFIER[entry.material]}))`
        );
      tolerance = entity(
        `( ${[...parts.keys()]
          .sort()
          .map((key) => parts.get(key)!)
          .join(' ')} )`
      );
    }
    if (entry.diameterZone) {
      const form = entity(`TOLERANCE_ZONE_FORM('cylindrical or circular')`);
      entity(`TOLERANCE_ZONE('', '', ${pds}, .F., (${tolerance}), ${form})`);
    }
    written += 1;
  }
  return written;
}

/** The length unit the file's geometric context assigns. */
function fileLengthUnit(byId: ReadonlyMap<string, string>): string {
  for (const text of byId.values()) {
    const assigned = /GLOBAL_UNIT_ASSIGNED_CONTEXT\(\(([^)]*)\)\)/.exec(text);
    if (!assigned) continue;
    const unit = references(assigned[1]!).find((id) =>
      /LENGTH_UNIT\(\)/.test(byId.get(id) ?? '')
    );
    if (unit) return unit;
  }
  throw new Error('The STEP file states no length unit; PMI export refused.');
}
