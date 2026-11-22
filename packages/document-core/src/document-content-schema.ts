import {
  documentNodesWithHistory,
  filletVertexRadiiProblem,
  patternSpacingModeProblem,
  type FeatureData,
  type PatternKind,
  type ProjectDocument,
  type SketchObjectData
} from '@openzcad/shared';
import { assertSketchObjectProjection } from './sketch-projections';

/** New content needs a declared schema; coercion or a missing version is no proof. */
export function assertMinimumProjectSchema(
  version: unknown,
  minimum: number,
  content: string
): void {
  if (
    typeof version !== 'number' ||
    !Number.isSafeInteger(version) ||
    version < minimum
  )
    throw new Error(`${content} require project schema v${minimum} or newer.`);
}

/** R01 datum points and coordinate systems (schema v99). */
export function assertDatumPointCsysSchema(version: unknown): void {
  assertMinimumProjectSchema(
    version,
    99,
    'Datum points and coordinate systems'
  );
}

/**
 * Whether `value` holds R01 v99 content anywhere: a datum point or
 * coordinate system feature, a datum-point or coordinate-system source, an
 * axis along a coordinate system, or a Move aligned by them. An older client
 * would fail to resolve every one of them, so a document holding one refuses.
 */
export function hasDatumPointCsysContent(value: unknown): boolean {
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  while (pending.length) {
    const item = pending.pop();
    if (typeof item !== 'object' || item === null || seen.has(item)) continue;
    seen.add(item);
    if (Array.isArray(item)) {
      for (const child of item as unknown[]) pending.push(child);
      continue;
    }
    const entry = item as Record<string, unknown>;
    if (
      entry.featureKind === 'datum-point' ||
      entry.featureKind === 'datum-csys' ||
      entry.type === 'datum-point' ||
      entry.type === 'datum-csys' ||
      entry.kind === 'csys-axis' ||
      entry.csysAlign !== undefined
    )
      return true;
    pending.push(...Object.values(entry));
  }
  return false;
}

/**
 * M10 linked copy stamps (schema v137): a transform copy, or the command
 * that makes one, stamping more than one copy. An older reader would build
 * only the first copy and lose the rest.
 */
export function assertTransformStampsSchema(
  data: unknown,
  version: unknown
): void {
  if (!record(data)) return;
  if (
    (Array.isArray(data.stampBodyIds) && data.stampBodyIds.length > 0) ||
    (typeof data.stamps === 'number' && data.stamps > 1) ||
    (Array.isArray(data.stampIds) && data.stampIds.length > 0)
  )
    assertMinimumProjectSchema(version, 137, 'Repeated copy stamps');
}

/** M06 ribs (schema v106). */
export function assertRibSchema(version: unknown): void {
  assertMinimumProjectSchema(version, 101, 'Ribs');
}

/** R01 reference constructors (schema v108). */
export function assertDatumReferenceConstructorSchema(version: unknown): void {
  assertMinimumProjectSchema(
    version,
    108,
    'Datum planes square to an edge or at an angle, and axes square to a face,'
  );
}

/**
 * Whether a datum plane or axis definition is an R01 v108 constructor: a
 * plane square to an edge, a plane through an edge at an angle, or an axis
 * square to a face. An older client cannot resolve them.
 */
export function hasDatumReferenceConstructorContent(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const data = value as { featureKind?: unknown; definition?: unknown };
  const kind =
    typeof data.definition === 'object' && data.definition !== null
      ? (data.definition as { kind?: unknown }).kind
      : undefined;
  return (
    (data.featureKind === 'datum-plane' &&
      (kind === 'normal-to-edge' || kind === 'edge-angle')) ||
    (data.featureKind === 'datum-axis' && kind === 'face-normal')
  );
}

/**
 * Whether a command payload (a new datum or an edit) holds a v108 datum
 * definition anywhere. The three kind names are used by nothing else.
 */
export function hasDatumReferenceConstructorKind(value: unknown): boolean {
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  while (pending.length) {
    const item = pending.pop();
    if (typeof item !== 'object' || item === null || seen.has(item)) continue;
    seen.add(item);
    if (Array.isArray(item)) {
      for (const child of item as unknown[]) pending.push(child);
      continue;
    }
    const entry = item as Record<string, unknown>;
    if (
      entry.kind === 'normal-to-edge' ||
      entry.kind === 'edge-angle' ||
      entry.kind === 'face-normal'
    )
      return true;
    pending.push(...Object.values(entry));
  }
  return false;
}

/** M12 wraps (schema v111). */
export function assertWrapSchema(version: unknown): void {
  assertMinimumProjectSchema(version, 111, 'Wraps');
}

/** I01 (schema v59): slot composites, wherever a document or command holds one. */
export function assertSlotSchema(version: unknown): void {
  assertMinimumProjectSchema(version, 59, 'Sketch slots');
}

export function assertObjectFolderSchema(version: unknown): void {
  assertMinimumProjectSchema(version, 34, 'Objects folders');
}

export function assertAssemblySchema(version: unknown): void {
  assertMinimumProjectSchema(version, 54, 'Assemblies');
}

/** AS02 joint couplings: `assembly.couplings` and its commands. */
export function assertAssemblyCouplingSchema(version: unknown): void {
  assertMinimumProjectSchema(version, 56, 'Joint couplings');
}

/**
 * L09 document print clearance (schema v60): `printClearance` and its
 * command. An older reader would build threads and gears without it.
 */
export function assertPrintClearanceSchema(version: unknown): void {
  assertMinimumProjectSchema(version, 60, 'A print clearance');
}

/**
 * D07 model-based definition (schema v106): `pmi` and its commands. An
 * older reader would drop the section on save.
 */
export function assertModelPmiSchema(version: unknown): void {
  assertMinimumProjectSchema(version, 106, 'Model PMI');
}

/**
 * F06 configurations (schema v72): `configurations` and its commands. An
 * older reader would show and export the bodies the active row hides.
 */
export const CONFIGURATION_SCHEMA_VERSION = 72;

/**
 * F06 per-view configurations (schema v89): a drawing view's
 * `configurationId`. An older reader would draw the view as the active row.
 */
export const DRAWING_VIEW_CONFIGURATION_SCHEMA_VERSION = 89;

export function assertDrawingViewConfigurationSchema(version: unknown): void {
  assertMinimumProjectSchema(
    version,
    DRAWING_VIEW_CONFIGURATION_SCHEMA_VERSION,
    'Drawing view configurations'
  );
}

/** F06: any view of a drawing section names a configuration. */
function hasDrawingViewConfiguration(drawings: unknown): boolean {
  return (
    record(drawings) &&
    Array.isArray(drawings.sheets) &&
    drawings.sheets.some(
      (sheet) =>
        record(sheet) &&
        Array.isArray(sheet.views) &&
        sheet.views.some(
          (view) => record(view) && view.configurationId !== undefined
        )
    )
  );
}

/**
 * AS03 exploded drawing views (schema v114): a drawing view's `exploded`.
 * An older reader would draw the view's bodies where they were modelled.
 */
export const DRAWING_EXPLODED_VIEW_SCHEMA_VERSION = 114;

export function assertDrawingExplodedViewSchema(version: unknown): void {
  assertMinimumProjectSchema(
    version,
    DRAWING_EXPLODED_VIEW_SCHEMA_VERSION,
    'Exploded drawing views'
  );
}

/** AS03: any view of a drawing section is drawn exploded. */
function hasDrawingExplodedView(drawings: unknown): boolean {
  return (
    record(drawings) &&
    Array.isArray(drawings.sheets) &&
    drawings.sheets.some(
      (sheet) =>
        record(sheet) &&
        Array.isArray(sheet.views) &&
        sheet.views.some((view) => record(view) && view.exploded !== undefined)
    )
  );
}

/**
 * F06 per-instance configurations (schema v90): an assembly component's
 * `configurationId`. An older reader would show the component as the
 * active row.
 */
export const COMPONENT_CONFIGURATION_SCHEMA_VERSION = 90;

export function assertComponentConfigurationSchema(version: unknown): void {
  assertMinimumProjectSchema(
    version,
    COMPONENT_CONFIGURATION_SCHEMA_VERSION,
    'Component configurations'
  );
}

export function assertConfigurationSchema(version: unknown): void {
  assertMinimumProjectSchema(
    version,
    CONFIGURATION_SCHEMA_VERSION,
    'Configurations'
  );
}

/**
 * M15 thread runouts and pipe threads (schema v57): a thread carrying either
 * needs a document that declares it, or an older reader would build a plain
 * end or a cylindrical thread in its place.
 */
export function assertThreadContentSchema(
  data: unknown,
  version: unknown
): void {
  if (!record(data)) return;
  if (
    data.runoutStart !== undefined ||
    data.runoutEnd !== undefined ||
    data.pipeSize !== undefined ||
    data.profile === 'npt' ||
    data.profile === 'bspt'
  )
    assertMinimumProjectSchema(version, 57, 'Thread runouts and pipe threads');
}

/**
 * M02 feature patterns and skipped copies (schema v62): a pattern carrying
 * either needs a document that declares it, or an older reader would copy
 * the whole body, or build every copy, in its place.
 */
export function assertPatternContentSchema(
  data: unknown,
  version: unknown
): void {
  if (!record(data)) return;
  if (
    data.sourceFeatureIds !== undefined ||
    data.skippedInstances !== undefined
  )
    assertMinimumProjectSchema(
      version,
      62,
      'Feature patterns and skipped pattern copies'
    );
  if (data.patternKind === 'points' || data.points !== undefined)
    assertMinimumProjectSchema(version, 63, 'Patterns on sketch points');
  if (data.patternKind === 'path' || data.path !== undefined)
    assertMinimumProjectSchema(version, 112, 'Patterns along a sketch path');
  if (data.patternKind === 'mirror' || data.mirrorPlane !== undefined)
    assertMinimumProjectSchema(version, 119, 'Mirror patterns');
  if (data.spacingMode !== undefined) {
    assertMinimumProjectSchema(version, 120, 'Total-length patterns');
    // Stored only on a linear pattern, as creating and editing one keep it
    // (review): another kind would build without it and read as with it.
    const problem = patternSpacingModeProblem({
      patternKind: data.patternKind as PatternKind,
      spacingMode: data.spacingMode
    });
    if (problem) throw new Error(problem);
  }
}

/**
 * M01 holes on sketch points (schema v64) and standard hole sizes (v65): a
 * hole carrying either needs a document that declares it, or an older
 * reader would drill one hole at the stored position, or drop the size, in
 * their place.
 */
export const STEP_STRUCTURE_SCHEMA_VERSION = 96;

/** I02: an import numbered by the product-structure reader needs v96. */
export function assertImportedStepContentSchema(
  data: unknown,
  version: unknown
): void {
  if (record(data) && data.stepReader !== undefined)
    assertMinimumProjectSchema(
      version,
      STEP_STRUCTURE_SCHEMA_VERSION,
      'Structured STEP imports'
    );
}

/** L15: custom features need the schema that declares them. */
export const CUSTOM_FEATURE_SCHEMA_VERSION = 110;

export function assertCustomFeatureSchema(version: unknown): void {
  assertMinimumProjectSchema(
    version,
    CUSTOM_FEATURE_SCHEMA_VERSION,
    'Custom features'
  );
}

export function assertHoleContentSchema(data: unknown, version: unknown): void {
  if (!record(data)) return;
  if (data.points !== undefined)
    assertMinimumProjectSchema(version, 64, 'Holes on sketch points');
  if (data.standard !== undefined)
    assertMinimumProjectSchema(version, 65, 'Standard hole sizes');
  if (data.tapped !== undefined)
    assertMinimumProjectSchema(version, 66, 'Tapped holes');
  if (record(data.tapped) && data.tapped.cosmetic !== undefined)
    assertMinimumProjectSchema(version, 67, 'Cosmetic threads');
}

/**
 * M16 sheet-metal features (schema v58): an older reader has no builder for
 * the kind and would drop the body, so the document must declare the schema.
 */
export function assertSheetMetalSchema(version: unknown): void {
  assertMinimumProjectSchema(version, 58, 'Sheet-metal features');
}

/**
 * D02 dimension tolerances, prefixes and suffixes (schema v68): a drawing
 * annotation carrying any needs a document that declares it, or an older
 * reader would print the bare value and drop them on its next save.
 */
export function assertDrawingDimensionFormatSchema(version: unknown): void {
  assertMinimumProjectSchema(
    version,
    68,
    'Dimension tolerances, prefixes and suffixes'
  );
}

/**
 * Whether `value` (a drawing set, a sheet, an annotation or a drawing
 * command's payload) holds an annotation with a v68 field. Walks records and
 * arrays only, once each.
 */
export function hasDrawingDimensionFormat(value: unknown): boolean {
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  while (pending.length) {
    const next = pending.pop();
    if (typeof next !== 'object' || next === null || seen.has(next)) continue;
    seen.add(next);
    if (Array.isArray(next)) {
      pending.push(...(next as unknown[]));
      continue;
    }
    const entry = next as Record<string, unknown>;
    if (
      typeof entry.annotationId === 'string' &&
      (entry.tolerance !== undefined ||
        entry.prefix !== undefined ||
        entry.suffix !== undefined)
    )
      return true;
    pending.push(...Object.values(entry));
  }
  return false;
}

/**
 * M17 standard parts (schema v69): an older reader has no builder for the
 * kind and would drop the body, so the document must declare the schema.
 */
export function assertStandardPartSchema(
  version: unknown,
  data?: unknown
): void {
  assertMinimumProjectSchema(version, 69, 'Standard parts');
  if (record(data) && data.hole !== undefined)
    assertMinimumProjectSchema(version, 77, 'Parts inserted into holes');
  if (record(data) && data.thread !== undefined)
    assertMinimumProjectSchema(version, 83, 'Simplified threads');
}

/**
 * D02 drawing properties (schema v70): a sheet carrying `format` needs a
 * document that declares it, or an older reader would print its dimensions
 * in the document's units and drop the properties on its next save.
 */
export function assertDrawingFormatSchema(version: unknown): void {
  assertMinimumProjectSchema(version, 70, 'Drawing properties');
}

/** Whether `value` holds a sheet, or a sheet update, that sets a format. */
export function hasDrawingFormat(value: unknown): boolean {
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  while (pending.length) {
    const next = pending.pop();
    if (typeof next !== 'object' || next === null || seen.has(next)) continue;
    seen.add(next);
    if (Array.isArray(next)) {
      pending.push(...(next as unknown[]));
      continue;
    }
    const entry = next as Record<string, unknown>;
    // A sheet, or a sheet update command's payload, which names its sheet
    // beside the properties it sets (null clears them).
    if (
      typeof entry.sheetId === 'string' &&
      entry.format !== undefined &&
      entry.format !== null
    )
      return true;
    pending.push(...Object.values(entry));
  }
  return false;
}

/**
 * D02 geometry annotations (schema v73): centre and intersection marks,
 * centrelines and mark points need a document that declares them.
 */
export function assertDrawingGeometrySchema(version: unknown): void {
  assertMinimumProjectSchema(
    version,
    73,
    'Centre marks, intersection marks and centrelines'
  );
}

const GEOMETRY_KINDS: readonly unknown[] = [
  'center-mark',
  'intersection-mark',
  'centerline'
];

/** Whether `value` holds a v73 geometry annotation or mark point. */
export function hasDrawingGeometry(value: unknown): boolean {
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  while (pending.length) {
    const next = pending.pop();
    if (typeof next !== 'object' || next === null || seen.has(next)) continue;
    seen.add(next);
    if (Array.isArray(next)) {
      pending.push(...(next as unknown[]));
      continue;
    }
    const entry = next as Record<string, unknown>;
    if (
      (typeof entry.annotationId === 'string' &&
        GEOMETRY_KINDS.includes(entry.kind)) ||
      entry.anchor === 'mark'
    )
      return true;
    pending.push(...Object.values(entry));
  }
  return false;
}

/** D02 distance dimensions (schema v75). */
export function assertDrawingDistanceSchema(version: unknown): void {
  assertMinimumProjectSchema(version, 75, 'Distance dimensions');
}

/** Whether `value` holds a v75 distance dimension. */
export function hasDrawingDistance(value: unknown): boolean {
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  while (pending.length) {
    const next = pending.pop();
    if (typeof next !== 'object' || next === null || seen.has(next)) continue;
    seen.add(next);
    if (Array.isArray(next)) {
      pending.push(...(next as unknown[]));
      continue;
    }
    const entry = next as Record<string, unknown>;
    if (typeof entry.annotationId === 'string' && entry.kind === 'distance')
      return true;
    pending.push(...Object.values(entry));
  }
  return false;
}

/** D03 detail views (schema v78). */
export function assertDrawingDetailSchema(version: unknown): void {
  assertMinimumProjectSchema(version, 78, 'Detail views');
}

/** Whether `value` holds a v78 detail view. */
export function hasDrawingDetail(value: unknown): boolean {
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  while (pending.length) {
    const next = pending.pop();
    if (typeof next !== 'object' || next === null || seen.has(next)) continue;
    seen.add(next);
    if (Array.isArray(next)) {
      pending.push(...(next as unknown[]));
      continue;
    }
    const entry = next as Record<string, unknown>;
    if (typeof entry.viewId === 'string' && entry.detail !== undefined)
      return true;
    pending.push(...Object.values(entry));
  }
  return false;
}

/** D02 parts lists and balloons (schema v80). */
export function assertDrawingBomSchema(version: unknown): void {
  assertMinimumProjectSchema(version, 80, 'Parts lists and balloons');
}

/** Whether `value` holds a v80 parts list or balloon. */
export function hasDrawingBom(value: unknown): boolean {
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  while (pending.length) {
    const next = pending.pop();
    if (typeof next !== 'object' || next === null || seen.has(next)) continue;
    seen.add(next);
    if (Array.isArray(next)) {
      pending.push(...(next as unknown[]));
      continue;
    }
    const entry = next as Record<string, unknown>;
    if (
      typeof entry.annotationId === 'string' &&
      (entry.kind === 'bom-table' || entry.kind === 'balloon')
    )
      return true;
    pending.push(...Object.values(entry));
  }
  return false;
}

/** M01 hole tables on drawing sheets (schema v117). */
export function assertDrawingHoleTableSchema(version: unknown): void {
  assertMinimumProjectSchema(version, 117, 'Hole tables');
}

/** Whether `value` holds an M01 hole table. */
export function hasDrawingHoleTable(value: unknown): boolean {
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  while (pending.length) {
    const next = pending.pop();
    if (typeof next !== 'object' || next === null || seen.has(next)) continue;
    seen.add(next);
    if (Array.isArray(next)) {
      pending.push(...(next as unknown[]));
      continue;
    }
    const entry = next as Record<string, unknown>;
    if (typeof entry.annotationId === 'string' && entry.kind === 'hole-table')
      return true;
    pending.push(...Object.values(entry));
  }
  return false;
}

/** D07 datum feature symbols and feature control frames (schema v98). */
export function assertDrawingToleranceSchema(version: unknown): void {
  assertMinimumProjectSchema(version, 98, 'Geometric tolerancing');
}

/** Whether `value` holds a v98 datum feature symbol or feature control frame. */
export function hasDrawingTolerance(value: unknown): boolean {
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  while (pending.length) {
    const next = pending.pop();
    if (typeof next !== 'object' || next === null || seen.has(next)) continue;
    seen.add(next);
    if (Array.isArray(next)) {
      pending.push(...(next as unknown[]));
      continue;
    }
    const entry = next as Record<string, unknown>;
    if (
      typeof entry.annotationId === 'string' &&
      (entry.kind === 'datum-feature' || entry.kind === 'feature-control-frame')
    )
      return true;
    pending.push(...Object.values(entry));
  }
  return false;
}

/** D07 fit and thread classes and general-tolerance blocks (schema v105). */
export function assertDrawingFitSchema(version: unknown): void {
  assertMinimumProjectSchema(version, 105, 'Fits and general tolerances');
}

/** Whether `value` holds a v105 fit, thread class or general-tolerance block. */
export function hasDrawingFit(value: unknown): boolean {
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  while (pending.length) {
    const next = pending.pop();
    if (typeof next !== 'object' || next === null || seen.has(next)) continue;
    seen.add(next);
    if (Array.isArray(next)) {
      pending.push(...(next as unknown[]));
      continue;
    }
    const entry = next as Record<string, unknown>;
    if (
      typeof entry.annotationId === 'string' &&
      (entry.kind === 'general-tolerance' ||
        entry.fit !== undefined ||
        entry.threadClass !== undefined)
    )
      return true;
    pending.push(...Object.values(entry));
  }
  return false;
}

/** D03 auxiliary views (schema v81). */
export function assertDrawingAuxiliarySchema(version: unknown): void {
  assertMinimumProjectSchema(version, 81, 'Auxiliary views');
}

/** Whether `value` holds a v81 auxiliary view. */
export function hasDrawingAuxiliary(value: unknown): boolean {
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  while (pending.length) {
    const next = pending.pop();
    if (typeof next !== 'object' || next === null || seen.has(next)) continue;
    seen.add(next);
    if (Array.isArray(next)) {
      pending.push(...(next as unknown[]));
      continue;
    }
    const entry = next as Record<string, unknown>;
    if (typeof entry.viewId === 'string' && entry.auxiliary !== undefined)
      return true;
    pending.push(...Object.values(entry));
  }
  return false;
}

/** D02 title-block layouts and shop fields (schema v94). */
export function assertDrawingTitleBlockLayoutSchema(version: unknown): void {
  assertMinimumProjectSchema(version, 94, 'Title-block layouts');
}

const SHOP_TITLE_FIELDS = [
  'company',
  'material',
  'finish',
  'checkedBy',
  'approvedBy',
  'tolerances'
];

/** Whether `value` holds a v94 title-block layout or shop field. */
export function hasDrawingTitleBlockLayout(value: unknown): boolean {
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  while (pending.length) {
    const next = pending.pop();
    if (typeof next !== 'object' || next === null || seen.has(next)) continue;
    seen.add(next);
    if (Array.isArray(next)) {
      pending.push(...(next as unknown[]));
      continue;
    }
    const entry = next as Record<string, unknown>;
    // A layout, or (in an update) its clearing to null.
    if (entry.titleBlockLayout !== undefined) return true;
    const block = entry.titleBlock;
    if (
      typeof block === 'object' &&
      block !== null &&
      SHOP_TITLE_FIELDS.some((key) => key in block)
    )
      return true;
    pending.push(...Object.values(entry));
  }
  return false;
}

/** D03 stepped sections (schema v93). */
export function assertDrawingSteppedSectionSchema(version: unknown): void {
  assertMinimumProjectSchema(version, 93, 'Stepped sections');
}

/** Whether `value` holds a v93 stepped section (a section with steps). */
export function hasDrawingSteppedSection(value: unknown): boolean {
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  while (pending.length) {
    const next = pending.pop();
    if (typeof next !== 'object' || next === null || seen.has(next)) continue;
    seen.add(next);
    if (Array.isArray(next)) {
      pending.push(...(next as unknown[]));
      continue;
    }
    const entry = next as Record<string, unknown>;
    if (
      typeof entry.sourceViewId === 'string' &&
      typeof entry.depth === 'number' &&
      Array.isArray(entry.steps) &&
      entry.steps.length > 0
    )
      return true;
    // A view update's `sectionSteps`, setting or clearing them.
    if (Array.isArray(entry.sectionSteps)) return true;
    pending.push(...Object.values(entry));
  }
  return false;
}

/** D02 sheet images (schema v92). */
export function assertDrawingImageSchema(version: unknown): void {
  assertMinimumProjectSchema(version, 92, 'Sheet images');
}

/** Whether `value` holds a v92 sheet image annotation. */
export function hasDrawingImage(value: unknown): boolean {
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  while (pending.length) {
    const next = pending.pop();
    if (typeof next !== 'object' || next === null || seen.has(next)) continue;
    seen.add(next);
    if (Array.isArray(next)) {
      pending.push(...(next as unknown[]));
      continue;
    }
    const entry = next as Record<string, unknown>;
    if (
      entry.kind === 'image' &&
      typeof entry.annotationId === 'string' &&
      entry.referenceImageId !== undefined
    )
      return true;
    pending.push(...Object.values(entry));
  }
  return false;
}

/** D03 free section planes (schema v91). */
export function assertDrawingFreeSectionSchema(version: unknown): void {
  assertMinimumProjectSchema(version, 91, 'Free section planes');
}

/** Whether `value` holds a v91 free section (a section with a frame). */
export function hasDrawingFreeSection(value: unknown): boolean {
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  while (pending.length) {
    const next = pending.pop();
    if (typeof next !== 'object' || next === null || seen.has(next)) continue;
    seen.add(next);
    if (Array.isArray(next)) {
      pending.push(...(next as unknown[]));
      continue;
    }
    const entry = next as Record<string, unknown>;
    if (
      typeof entry.sourceViewId === 'string' &&
      typeof entry.depth === 'number' &&
      entry.frame !== undefined
    )
      return true;
    pending.push(...Object.values(entry));
  }
  return false;
}

/** D02 arc and three-point angle dimensions (schema v82). */
export function assertDrawingAngleSchema(version: unknown): void {
  assertMinimumProjectSchema(version, 82, 'Arc and three-point angles');
}

/** Whether `value` holds a v82 arc or three-point angle. */
export function hasDrawingAngle(value: unknown): boolean {
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  while (pending.length) {
    const next = pending.pop();
    if (typeof next !== 'object' || next === null || seen.has(next)) continue;
    seen.add(next);
    if (Array.isArray(next)) {
      pending.push(...(next as unknown[]));
      continue;
    }
    const entry = next as Record<string, unknown>;
    if (
      typeof entry.annotationId === 'string' &&
      (entry.kind === 'arc-angle' || entry.kind === 'three-point-angle')
    )
      return true;
    pending.push(...Object.values(entry));
  }
  return false;
}

function hasCouplings(assembly: unknown): boolean {
  return record(assembly) && assembly.couplings !== undefined;
}

/** AS03 exploded view: `assembly.explode` and its command. */
export function assertAssemblyExplodeSchema(version: unknown): void {
  assertMinimumProjectSchema(version, 61, 'Exploded views');
}

function hasExplode(assembly: unknown): boolean {
  return record(assembly) && assembly.explode !== undefined;
}

/** F06: any component of an assembly section names a configuration. */
function hasComponentConfiguration(assembly: unknown): boolean {
  return (
    record(assembly) &&
    Array.isArray(assembly.components) &&
    assembly.components.some(
      (component) =>
        record(component) && component.configurationId !== undefined
    )
  );
}

export function assertSketchObjectContentSchema(
  data: SketchObjectData,
  version: unknown,
  objectId?: string
): void {
  if (data.projection !== undefined)
    assertMinimumProjectSchema(version, 33, 'Sketch projections');
  if (data.objectKind === 'point')
    assertMinimumProjectSchema(version, 59, 'Sketch points');
  assertSketchObjectProjection(data, objectId);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Inspect only known command carriers, including saved undo/redo log copies. */
export function assertDocumentContentCommandSchema(
  document: Pick<
    ProjectDocument,
    'schemaVersion' | 'commandLog' | 'editHistory'
  >
): void {
  const pending: unknown[] = [document.commandLog];
  for (const entry of document.editHistory?.entries ?? [])
    for (const change of entry.changes)
      if (change.field === 'commandLog')
        pending.push(change.before, change.after);
  const seen = new Set<object>();
  // Objects whose kind or fields need a newer schema: a projection (v33)
  // or a point (v59), wherever a saved command carries one.
  const object = (value: unknown) => {
    if (
      record(value) &&
      (value.projection !== undefined || value.objectKind === 'point')
    )
      assertSketchObjectContentSchema(
        value as unknown as SketchObjectData,
        document.schemaVersion
      );
  };
  while (pending.length) {
    const command = pending.pop();
    if (Array.isArray(command)) {
      if (seen.has(command)) continue;
      seen.add(command);
      for (const child of command) pending.push(child);
      continue;
    }
    if (!record(command) || seen.has(command)) continue;
    seen.add(command);
    if (command.kind === 'transaction') pending.push(command.payload);
    if (
      command.kind === 'objectFolder.create' ||
      command.kind === 'objectFolder.rename' ||
      command.kind === 'objectFolder.delete' ||
      command.kind === 'objectFolder.move'
    )
      assertObjectFolderSchema(document.schemaVersion);
    if (
      typeof command.kind === 'string' &&
      command.kind.startsWith('assembly.')
    )
      assertAssemblySchema(document.schemaVersion);
    if (
      typeof command.kind === 'string' &&
      command.kind.startsWith('assembly.coupling.')
    )
      assertAssemblyCouplingSchema(document.schemaVersion);
    if (command.kind === 'assembly.explode.set')
      assertAssemblyExplodeSchema(document.schemaVersion);
    if (
      command.kind === 'assembly.component.update' &&
      record(command.payload) &&
      command.payload.configurationId !== undefined
    )
      assertComponentConfigurationSchema(document.schemaVersion);
    if (command.kind === 'feature.sheet-metal')
      assertSheetMetalSchema(document.schemaVersion);
    if (
      command.kind === 'feature.datum-point' ||
      command.kind === 'feature.datum-csys' ||
      (typeof command.kind === 'string' &&
        command.kind.startsWith('feature.') &&
        hasDatumPointCsysContent(command.payload))
    )
      assertDatumPointCsysSchema(document.schemaVersion);
    if (command.kind === 'feature.rib') assertRibSchema(document.schemaVersion);
    if (
      typeof command.kind === 'string' &&
      command.kind.startsWith('feature.') &&
      hasDatumReferenceConstructorKind(command.payload)
    )
      assertDatumReferenceConstructorSchema(document.schemaVersion);
    if (command.kind === 'feature.wrap')
      assertWrapSchema(document.schemaVersion);
    if (command.kind === 'feature.standard-part')
      assertStandardPartSchema(document.schemaVersion, command.payload);
    if (command.kind === 'printClearance.set')
      assertPrintClearanceSchema(document.schemaVersion);
    if (typeof command.kind === 'string' && command.kind.startsWith('pmi.'))
      assertModelPmiSchema(document.schemaVersion);
    if (
      typeof command.kind === 'string' &&
      command.kind.startsWith('configuration.')
    )
      assertConfigurationSchema(document.schemaVersion);
    if (
      command.kind === 'drawing.view.update' &&
      record(command.payload) &&
      command.payload.configurationId !== undefined
    )
      assertDrawingViewConfigurationSchema(document.schemaVersion);
    if (
      (command.kind === 'drawing.view.update' &&
        record(command.payload) &&
        command.payload.exploded !== undefined) ||
      (command.kind === 'drawing.view.add' &&
        record(command.payload) &&
        record(command.payload.view) &&
        command.payload.view.exploded !== undefined) ||
      (command.kind === 'drawing.sheet.add' &&
        record(command.payload) &&
        hasDrawingExplodedView({ sheets: [command.payload.sheet] }))
    )
      assertDrawingExplodedViewSchema(document.schemaVersion);
    if (
      typeof command.kind === 'string' &&
      command.kind.startsWith('drawing.') &&
      hasDrawingDimensionFormat(command.payload)
    )
      assertDrawingDimensionFormatSchema(document.schemaVersion);
    if (
      typeof command.kind === 'string' &&
      command.kind.startsWith('drawing.') &&
      hasDrawingFormat(command.payload)
    )
      assertDrawingFormatSchema(document.schemaVersion);
    if (
      typeof command.kind === 'string' &&
      command.kind.startsWith('drawing.') &&
      hasDrawingGeometry(command.payload)
    )
      assertDrawingGeometrySchema(document.schemaVersion);
    if (
      typeof command.kind === 'string' &&
      command.kind.startsWith('drawing.') &&
      hasDrawingDistance(command.payload)
    )
      assertDrawingDistanceSchema(document.schemaVersion);
    if (
      typeof command.kind === 'string' &&
      command.kind.startsWith('drawing.') &&
      hasDrawingAngle(command.payload)
    )
      assertDrawingAngleSchema(document.schemaVersion);
    if (
      typeof command.kind === 'string' &&
      command.kind.startsWith('drawing.') &&
      hasDrawingFreeSection(command.payload)
    )
      assertDrawingFreeSectionSchema(document.schemaVersion);
    if (
      typeof command.kind === 'string' &&
      command.kind.startsWith('drawing.') &&
      hasDrawingImage(command.payload)
    )
      assertDrawingImageSchema(document.schemaVersion);
    if (
      typeof command.kind === 'string' &&
      command.kind.startsWith('drawing.') &&
      hasDrawingSteppedSection(command.payload)
    )
      assertDrawingSteppedSectionSchema(document.schemaVersion);
    if (
      typeof command.kind === 'string' &&
      command.kind.startsWith('drawing.') &&
      hasDrawingTitleBlockLayout(command.payload)
    )
      assertDrawingTitleBlockLayoutSchema(document.schemaVersion);
    if (
      typeof command.kind === 'string' &&
      command.kind.startsWith('drawing.') &&
      hasDrawingDetail(command.payload)
    )
      assertDrawingDetailSchema(document.schemaVersion);
    if (
      typeof command.kind === 'string' &&
      command.kind.startsWith('drawing.') &&
      hasDrawingBom(command.payload)
    )
      assertDrawingBomSchema(document.schemaVersion);
    if (
      typeof command.kind === 'string' &&
      command.kind.startsWith('drawing.') &&
      hasDrawingHoleTable(command.payload)
    )
      assertDrawingHoleTableSchema(document.schemaVersion);
    if (
      typeof command.kind === 'string' &&
      command.kind.startsWith('drawing.') &&
      hasDrawingTolerance(command.payload)
    )
      assertDrawingToleranceSchema(document.schemaVersion);
    if (
      typeof command.kind === 'string' &&
      command.kind.startsWith('drawing.') &&
      hasDrawingFit(command.payload)
    )
      assertDrawingFitSchema(document.schemaVersion);
    if (
      typeof command.kind === 'string' &&
      command.kind.startsWith('drawing.') &&
      hasDrawingAuxiliary(command.payload)
    )
      assertDrawingAuxiliarySchema(document.schemaVersion);
    if (!record(command.payload)) continue;
    if (
      command.kind === 'sketch.composite.add' &&
      record(command.payload.composite) &&
      command.payload.composite.compositeKind === 'slot'
    )
      assertSlotSchema(document.schemaVersion);
    if (command.kind === 'feature.thread')
      assertThreadContentSchema(command.payload, document.schemaVersion);
    if (command.kind === 'import.step')
      assertImportedStepContentSchema(command.payload, document.schemaVersion);
    if (command.kind === 'feature.custom-feature')
      assertCustomFeatureSchema(document.schemaVersion);
    if (command.kind === 'feature.pattern')
      assertPatternContentSchema(command.payload, document.schemaVersion);
    if (command.kind === 'feature.transform')
      assertTransformStampsSchema(command.payload, document.schemaVersion);
    if (command.kind === 'feature.hole')
      assertHoleContentSchema(command.payload, document.schemaVersion);
    // A hole patch names its kind (the History edit sends the whole data).
    if (
      record(command.payload.data) &&
      command.payload.data.featureKind === 'hole'
    )
      assertHoleContentSchema(command.payload.data, document.schemaVersion);
    // Pattern-only fields, gated however the patch names its kind.
    if (
      record(command.payload.data) &&
      (command.payload.data.featureKind === undefined ||
        command.payload.data.featureKind === 'pattern')
    )
      assertPatternContentSchema(command.payload.data, document.schemaVersion);
    // A feature patch (`feature.update`) need not name its kind, so a
    // partial `{ runoutEnd: true }` is gated by its fields: they are
    // thread-only, so any patch that is not another kind's carries them
    // only as a thread.
    if (
      record(command.payload.data) &&
      (command.payload.data.featureKind === undefined ||
        command.payload.data.featureKind === 'thread')
    )
      assertThreadContentSchema(command.payload.data, document.schemaVersion);
    // M17 (schema v77): `hole` is a standard part's only, so a patch that
    // carries one and is not another kind's inserts the part into a hole.
    if (
      record(command.payload.data) &&
      command.payload.data.hole !== undefined &&
      (command.payload.data.featureKind === undefined ||
        command.payload.data.featureKind === 'standard-part')
    )
      assertMinimumProjectSchema(
        document.schemaVersion,
        77,
        'Parts inserted into holes'
      );
    // M17 (schema v83): `thread` is a standard part's only, as `hole` is.
    if (
      record(command.payload.data) &&
      command.payload.data.thread !== undefined &&
      (command.payload.data.featureKind === undefined ||
        command.payload.data.featureKind === 'standard-part')
    )
      assertMinimumProjectSchema(
        document.schemaVersion,
        83,
        'Simplified threads'
      );
    // M04 (schema v133): a loft's connections and guide, created or patched
    // (a patch need not name its kind; the fields are a loft's).
    {
      const loft =
        command.kind === 'feature.loft'
          ? command.payload
          : record(command.payload.data) &&
              (command.payload.data.featureKind === undefined ||
                command.payload.data.featureKind === 'loft')
            ? command.payload.data
            : null;
      if (loft && (loft.connections !== undefined || loft.guides !== undefined))
        assertMinimumProjectSchema(
          document.schemaVersion,
          133,
          'Loft connections and guides'
        );
    }
    // M04: an exact sweep's options, created or patched (a patch need not
    // name its kind; the fields are a sweep's).
    {
      const sweep =
        command.kind === 'feature.sweep'
          ? command.payload
          : record(command.payload.data) &&
              (command.payload.data.featureKind === undefined ||
                command.payload.data.featureKind === 'sweep')
            ? command.payload.data
            : null;
      if (sweep) assertSweepContentSchema(sweep, document.schemaVersion);
    }
    // M03: per-vertex fillet radii, created or patched.
    {
      const fillet =
        command.kind === 'feature.fillet'
          ? command.payload
          : record(command.payload.data) &&
              (command.payload.data.featureKind === undefined ||
                command.payload.data.featureKind === 'fillet')
            ? command.payload.data
            : null;
      if (fillet && fillet.vertexRadii !== undefined)
        assertMinimumProjectSchema(
          document.schemaVersion,
          142,
          'Per-vertex fillet radii'
        );
    }
    switch (command.kind) {
      case 'sketch.add':
      case 'sketch.object.add':
        if (Array.isArray(command.payload.objects))
          command.payload.objects.forEach(object);
        if (command.kind === 'sketch.add') object(command.payload.object);
        break;
      case 'sketch.update':
        object(command.payload.object);
        break;
      case 'sketch.object.update':
        object(command.payload.data);
        break;
    }
  }
}

/** Call after validating or dropping unreadable history at the entry boundary. */
/**
 * M04: the schema each exact-sweep option needs, for a stored sweep node and
 * for a replayed command alike. A default (no twist, unit scale) needs none.
 */
function assertSweepContentSchema(
  sweep: Record<string, unknown>,
  version: unknown
): void {
  if (
    (sweep.twistDeg !== undefined &&
      sweep.twistDeg !== 0 &&
      sweep.twistDeg !== '0') ||
    (sweep.endScale !== undefined &&
      sweep.endScale !== 1 &&
      sweep.endScale !== '1')
  )
    assertMinimumProjectSchema(version, 132, 'Sweep twist and end scale');
  if (sweep.orientation !== undefined)
    assertMinimumProjectSchema(version, 134, 'Sweep orientation');
  if (sweep.cornerRadius !== undefined)
    assertMinimumProjectSchema(version, 135, 'Round sweep corners');
  if (sweep.profilePosition !== undefined)
    assertMinimumProjectSchema(version, 136, 'Sweep profile position');
}

/**
 * M03 (schema v142): a stored fillet's per-vertex radii need the version and
 * a well-formed list (a variable law, a reference for each named edge, one
 * entry per edge end).
 */
export function assertFilletContentSchema(
  data: Extract<FeatureData, { featureKind: 'fillet' }>,
  version: unknown
): void {
  if (data.vertexRadii === undefined) return;
  assertMinimumProjectSchema(version, 142, 'Per-vertex fillet radii');
  const problem = filletVertexRadiiProblem(data);
  if (problem) throw new Error(problem);
}

export function assertDocumentContentSchema(document: ProjectDocument): void {
  if (document.objectFolders !== undefined)
    assertObjectFolderSchema(document.schemaVersion);
  for (const entry of document.editHistory?.entries ?? [])
    for (const change of entry.changes)
      if (
        change.field === 'objectFolders' &&
        (change.before !== undefined || change.after !== undefined)
      )
        assertObjectFolderSchema(document.schemaVersion);
  if (document.pmi !== undefined) assertModelPmiSchema(document.schemaVersion);
  for (const entry of document.editHistory?.entries ?? [])
    for (const change of entry.changes)
      if (
        change.field === 'pmi' &&
        (change.before !== undefined || change.after !== undefined)
      )
        assertModelPmiSchema(document.schemaVersion);
  if (document.printClearance !== undefined)
    assertPrintClearanceSchema(document.schemaVersion);
  for (const entry of document.editHistory?.entries ?? [])
    for (const change of entry.changes)
      if (
        change.field === 'printClearance' &&
        (change.before !== undefined || change.after !== undefined)
      )
        assertPrintClearanceSchema(document.schemaVersion);
  if (document.configurations !== undefined)
    assertConfigurationSchema(document.schemaVersion);
  if (hasDrawingViewConfiguration(document.drawings))
    assertDrawingViewConfigurationSchema(document.schemaVersion);
  if (hasDrawingExplodedView(document.drawings))
    assertDrawingExplodedViewSchema(document.schemaVersion);
  for (const entry of document.editHistory?.entries ?? [])
    for (const change of entry.changes)
      if (
        change.field === 'drawings' &&
        (hasDrawingExplodedView(change.before) ||
          hasDrawingExplodedView(change.after))
      )
        assertDrawingExplodedViewSchema(document.schemaVersion);
  for (const entry of document.editHistory?.entries ?? [])
    for (const change of entry.changes)
      if (
        change.field === 'drawings' &&
        (hasDrawingViewConfiguration(change.before) ||
          hasDrawingViewConfiguration(change.after))
      )
        assertDrawingViewConfigurationSchema(document.schemaVersion);
  for (const entry of document.editHistory?.entries ?? [])
    for (const change of entry.changes)
      if (
        change.field === 'configurations' &&
        (change.before !== undefined || change.after !== undefined)
      )
        assertConfigurationSchema(document.schemaVersion);
  if (document.assembly !== undefined)
    assertAssemblySchema(document.schemaVersion);
  if (hasCouplings(document.assembly))
    assertAssemblyCouplingSchema(document.schemaVersion);
  if (hasExplode(document.assembly))
    assertAssemblyExplodeSchema(document.schemaVersion);
  if (hasComponentConfiguration(document.assembly))
    assertComponentConfigurationSchema(document.schemaVersion);
  for (const entry of document.editHistory?.entries ?? [])
    for (const change of entry.changes)
      if (change.field === 'assembly') {
        if (change.before !== undefined || change.after !== undefined)
          assertAssemblySchema(document.schemaVersion);
        if (hasCouplings(change.before) || hasCouplings(change.after))
          assertAssemblyCouplingSchema(document.schemaVersion);
        if (hasExplode(change.before) || hasExplode(change.after))
          assertAssemblyExplodeSchema(document.schemaVersion);
        if (
          hasComponentConfiguration(change.before) ||
          hasComponentConfiguration(change.after)
        )
          assertComponentConfigurationSchema(document.schemaVersion);
      }
  if (hasDrawingDimensionFormat(document.drawings))
    assertDrawingDimensionFormatSchema(document.schemaVersion);
  if (hasDrawingFormat(document.drawings))
    assertDrawingFormatSchema(document.schemaVersion);
  if (hasDrawingGeometry(document.drawings))
    assertDrawingGeometrySchema(document.schemaVersion);
  if (hasDrawingDistance(document.drawings))
    assertDrawingDistanceSchema(document.schemaVersion);
  if (hasDrawingAngle(document.drawings))
    assertDrawingAngleSchema(document.schemaVersion);
  for (const entry of document.editHistory?.entries ?? [])
    for (const change of entry.changes)
      if (
        change.field === 'drawings' &&
        (hasDrawingAngle(change.before) || hasDrawingAngle(change.after))
      )
        assertDrawingAngleSchema(document.schemaVersion);
  if (hasDrawingFreeSection(document.drawings))
    assertDrawingFreeSectionSchema(document.schemaVersion);
  for (const entry of document.editHistory?.entries ?? [])
    for (const change of entry.changes)
      if (
        change.field === 'drawings' &&
        (hasDrawingFreeSection(change.before) ||
          hasDrawingFreeSection(change.after))
      )
        assertDrawingFreeSectionSchema(document.schemaVersion);
  if (hasDrawingImage(document.drawings))
    assertDrawingImageSchema(document.schemaVersion);
  for (const entry of document.editHistory?.entries ?? [])
    for (const change of entry.changes)
      if (
        change.field === 'drawings' &&
        (hasDrawingImage(change.before) || hasDrawingImage(change.after))
      )
        assertDrawingImageSchema(document.schemaVersion);
  if (hasDrawingSteppedSection(document.drawings))
    assertDrawingSteppedSectionSchema(document.schemaVersion);
  for (const entry of document.editHistory?.entries ?? [])
    for (const change of entry.changes)
      if (
        change.field === 'drawings' &&
        (hasDrawingSteppedSection(change.before) ||
          hasDrawingSteppedSection(change.after))
      )
        assertDrawingSteppedSectionSchema(document.schemaVersion);
  if (hasDrawingTitleBlockLayout(document.drawings))
    assertDrawingTitleBlockLayoutSchema(document.schemaVersion);
  for (const entry of document.editHistory?.entries ?? [])
    for (const change of entry.changes)
      if (
        change.field === 'drawings' &&
        (hasDrawingTitleBlockLayout(change.before) ||
          hasDrawingTitleBlockLayout(change.after))
      )
        assertDrawingTitleBlockLayoutSchema(document.schemaVersion);
  if (hasDrawingDetail(document.drawings))
    assertDrawingDetailSchema(document.schemaVersion);
  if (hasDrawingBom(document.drawings))
    assertDrawingBomSchema(document.schemaVersion);
  if (hasDrawingHoleTable(document.drawings))
    assertDrawingHoleTableSchema(document.schemaVersion);
  for (const entry of document.editHistory?.entries ?? [])
    for (const change of entry.changes)
      if (
        change.field === 'drawings' &&
        (hasDrawingHoleTable(change.before) ||
          hasDrawingHoleTable(change.after))
      )
        assertDrawingHoleTableSchema(document.schemaVersion);
  if (hasDrawingTolerance(document.drawings))
    assertDrawingToleranceSchema(document.schemaVersion);
  for (const entry of document.editHistory?.entries ?? [])
    for (const change of entry.changes)
      if (
        change.field === 'drawings' &&
        (hasDrawingTolerance(change.before) ||
          hasDrawingTolerance(change.after))
      )
        assertDrawingToleranceSchema(document.schemaVersion);
  if (hasDrawingFit(document.drawings))
    assertDrawingFitSchema(document.schemaVersion);
  for (const entry of document.editHistory?.entries ?? [])
    for (const change of entry.changes)
      if (
        change.field === 'drawings' &&
        (hasDrawingFit(change.before) || hasDrawingFit(change.after))
      )
        assertDrawingFitSchema(document.schemaVersion);
  if (hasDrawingAuxiliary(document.drawings))
    assertDrawingAuxiliarySchema(document.schemaVersion);
  for (const entry of document.editHistory?.entries ?? [])
    for (const change of entry.changes)
      if (
        change.field === 'drawings' &&
        (hasDrawingAuxiliary(change.before) ||
          hasDrawingAuxiliary(change.after))
      )
        assertDrawingAuxiliarySchema(document.schemaVersion);
  for (const entry of document.editHistory?.entries ?? [])
    for (const change of entry.changes)
      if (
        change.field === 'drawings' &&
        (hasDrawingBom(change.before) || hasDrawingBom(change.after))
      )
        assertDrawingBomSchema(document.schemaVersion);
  for (const entry of document.editHistory?.entries ?? [])
    for (const change of entry.changes)
      if (
        change.field === 'drawings' &&
        (hasDrawingDetail(change.before) || hasDrawingDetail(change.after))
      )
        assertDrawingDetailSchema(document.schemaVersion);
  for (const entry of document.editHistory?.entries ?? [])
    for (const change of entry.changes)
      if (
        change.field === 'drawings' &&
        (hasDrawingDistance(change.before) || hasDrawingDistance(change.after))
      )
        assertDrawingDistanceSchema(document.schemaVersion);
  for (const entry of document.editHistory?.entries ?? [])
    for (const change of entry.changes)
      if (
        change.field === 'drawings' &&
        (hasDrawingGeometry(change.before) || hasDrawingGeometry(change.after))
      )
        assertDrawingGeometrySchema(document.schemaVersion);
  for (const entry of document.editHistory?.entries ?? [])
    for (const change of entry.changes)
      if (
        change.field === 'drawings' &&
        (hasDrawingDimensionFormat(change.before) ||
          hasDrawingDimensionFormat(change.after))
      )
        assertDrawingDimensionFormatSchema(document.schemaVersion);
  for (const entry of document.editHistory?.entries ?? [])
    for (const change of entry.changes)
      if (
        change.field === 'drawings' &&
        (hasDrawingFormat(change.before) || hasDrawingFormat(change.after))
      )
        assertDrawingFormatSchema(document.schemaVersion);
  for (const node of documentNodesWithHistory(document)) {
    if (node.kind === 'sketch-object')
      assertSketchObjectContentSchema(
        node.data,
        document.schemaVersion,
        node.id
      );
    if (node.kind === 'feature' && node.data.featureKind === 'thread')
      assertThreadContentSchema(node.data, document.schemaVersion);
    if (
      node.kind === 'feature' &&
      node.data.featureKind === 'loft' &&
      (node.data.connections !== undefined || node.data.guides !== undefined)
    )
      assertMinimumProjectSchema(
        document.schemaVersion,
        133,
        'Loft connections and guides'
      );
    if (node.kind === 'feature' && node.data.featureKind === 'sweep')
      assertSweepContentSchema(node.data, document.schemaVersion);
    if (node.kind === 'feature' && node.data.featureKind === 'fillet')
      assertFilletContentSchema(node.data, document.schemaVersion);
    if (node.kind === 'feature' && node.data.featureKind === 'imported-step')
      assertImportedStepContentSchema(node.data, document.schemaVersion);
    if (node.kind === 'feature' && node.data.featureKind === 'custom-feature')
      assertCustomFeatureSchema(document.schemaVersion);
    if (node.kind === 'feature' && node.data.featureKind === 'pattern')
      assertPatternContentSchema(node.data, document.schemaVersion);
    if (node.kind === 'feature' && node.data.featureKind === 'transform')
      assertTransformStampsSchema(node.data, document.schemaVersion);
    if (node.kind === 'feature' && node.data.featureKind === 'hole')
      assertHoleContentSchema(node.data, document.schemaVersion);
    if (node.kind === 'feature' && node.data.featureKind === 'sheet-metal')
      assertSheetMetalSchema(document.schemaVersion);
    if (node.kind === 'feature' && hasDatumPointCsysContent(node.data))
      assertDatumPointCsysSchema(document.schemaVersion);
    if (node.kind === 'feature' && node.data.featureKind === 'rib')
      assertRibSchema(document.schemaVersion);
    if (
      node.kind === 'feature' &&
      hasDatumReferenceConstructorContent(node.data)
    )
      assertDatumReferenceConstructorSchema(document.schemaVersion);
    if (node.kind === 'feature' && node.data.featureKind === 'wrap')
      assertWrapSchema(document.schemaVersion);
    if (node.kind === 'feature' && node.data.featureKind === 'standard-part')
      assertStandardPartSchema(document.schemaVersion, node.data);
    if (
      node.kind === 'sketch' &&
      Array.isArray(node.composites) &&
      node.composites.some(
        (composite) => record(composite) && composite.compositeKind === 'slot'
      )
    )
      assertSlotSchema(document.schemaVersion);
  }
  assertDocumentContentCommandSchema(document);
}
