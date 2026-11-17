import type { Brand, Vector3 } from './index';
import {
  drawingFaceRefError,
  toleranceFieldsError,
  type DrawingDatumReference,
  type DrawingFaceRef,
  type DrawingGeometricCharacteristic,
  type DrawingMaterialCondition
} from './drawing-annotations';

/**
 * D07 slice C (schema v106): model-based definition. Datum feature symbols
 * and feature control frames stored on the model itself, each on one face
 * of a body, so the part carries its tolerancing without a drawing (and a
 * STEP AP242 export can write it as semantic PMI).
 *
 * Like a drawing annotation, an entry stores intent only: the face it
 * applies to, held by its ADR-013 lineage name then its ADR-011 hash, and
 * the point on the model its label's leader lands on. A face that no longer
 * resolves to exactly one face leaves the entry broken until it is
 * re-picked or deleted; nothing rebinds to a nearby face. The frame and
 * datum fields mean what they mean on a drawing (`toleranceFieldsError`),
 * except that a frame's `amount` is in the document's units, since the
 * model has no sheet.
 */

export type ModelPmiId = Brand<string, 'ModelPmiId'>;

export const MODEL_PMI_ID_PREFIX = 'pmi_';

export function createModelPmiId(): ModelPmiId {
  return `${MODEL_PMI_ID_PREFIX}${crypto.randomUUID()}` as ModelPmiId;
}

interface ModelPmiBase {
  pmiId: ModelPmiId;
  /** The toleranced face, or the datum feature. */
  face: DrawingFaceRef;
  /** Where the label's leader lands, a point on the face (model units). */
  anchor: Vector3;
}

export interface ModelDatumFeature extends ModelPmiBase {
  kind: 'datum-feature';
  letter: string;
}

export interface ModelFeatureControlFrame extends ModelPmiBase {
  kind: 'feature-control-frame';
  characteristic: DrawingGeometricCharacteristic;
  /** The tolerance zone's size, in the document's units. */
  amount: number;
  diameterZone?: true;
  material?: DrawingMaterialCondition;
  datums?: DrawingDatumReference[];
}

export type ModelPmiAnnotation = ModelDatumFeature | ModelFeatureControlFrame;

/** The document's PMI; stored absent rather than empty. */
export interface ModelPmiSet {
  annotations: ModelPmiAnnotation[];
}

export const MAX_MODEL_PMI = 500;
const MAX_ANCHOR = 1e7;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const KEYS: Readonly<Record<ModelPmiAnnotation['kind'], readonly string[]>> = {
  'datum-feature': ['pmiId', 'kind', 'face', 'anchor', 'letter'],
  'feature-control-frame': [
    'pmiId',
    'kind',
    'face',
    'anchor',
    'characteristic',
    'amount',
    'diameterZone',
    'material',
    'datums'
  ]
};

/** Why `value` is not a stored PMI entry, or null. */
export function modelPmiError(value: unknown, where: string): string | null {
  if (!isRecord(value)) return `${where} is not a PMI record.`;
  if (
    typeof value.pmiId !== 'string' ||
    !value.pmiId.startsWith(MODEL_PMI_ID_PREFIX) ||
    value.pmiId.length > 64
  )
    return `${where} has an invalid id.`;
  const keys = KEYS[value.kind as ModelPmiAnnotation['kind']];
  if (!keys) return `${where} is neither a datum feature nor a frame.`;
  const extra = Object.keys(value).find((key) => !keys.includes(key));
  if (extra !== undefined) return `${where} has no ${extra}.`;
  if (!isRecord(value.face)) return `${where} names no face.`;
  const face = drawingFaceRefError(value.face as unknown as DrawingFaceRef);
  if (face) return `${where} ${face}.`;
  const anchor = value.anchor;
  if (
    !isRecord(anchor) ||
    Object.keys(anchor).length !== 3 ||
    ![anchor.x, anchor.y, anchor.z].every(
      (coordinate) =>
        typeof coordinate === 'number' &&
        Number.isFinite(coordinate) &&
        Math.abs(coordinate) <= MAX_ANCHOR
    )
  )
    return `${where} has an invalid anchor point.`;
  return toleranceFieldsError(value, where);
}

/** Why `value` is not a valid PMI section, or null. */
export function modelPmiSetError(value: unknown): string | null {
  if (!isRecord(value) || !Array.isArray(value.annotations))
    return 'The PMI section is not an annotation list.';
  if (Object.keys(value).length !== 1)
    return 'The PMI section holds only its annotations.';
  if (value.annotations.length === 0)
    return 'An empty PMI section is stored as absent.';
  if (value.annotations.length > MAX_MODEL_PMI)
    return `A project holds at most ${MAX_MODEL_PMI} PMI annotations.`;
  const ids = new Set<string>();
  const letters = new Set<string>();
  for (const [index, entry] of value.annotations.entries()) {
    const error = modelPmiError(entry, `PMI annotation ${index + 1}`);
    if (error) return error;
    const annotation = entry as ModelPmiAnnotation;
    if (ids.has(annotation.pmiId))
      return `PMI annotation ${annotation.pmiId} is listed twice.`;
    ids.add(annotation.pmiId);
    // One datum per letter: a model has one datum reference frame, and a
    // second A would make every frame naming A ambiguous.
    if (annotation.kind === 'datum-feature') {
      if (letters.has(annotation.letter))
        return `Datum ${annotation.letter} is declared twice on the model.`;
      letters.add(annotation.letter);
    }
  }
  return null;
}

/** Fails closed on a malformed PMI section; absent is valid. */
export function assertModelPmiSet(value: unknown): void {
  if (value === undefined) return;
  const error = modelPmiSetError(value);
  if (error) throw new Error(error);
}
