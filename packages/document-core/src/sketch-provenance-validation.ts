import {
  documentNodesWithHistory,
  isBoundaryProvenance,
  isLegacyCompositeObjectData,
  isSketchBoundaryEntityId,
  isSketchPromotion,
  promotionStructureObjectIds,
  type ProjectDocument,
  type SketchPromotion
} from '@openzcad/shared';

const PROVENANCE_SCHEMA_VERSION = 37;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function identities(value: unknown): value is string[] {
  return (
    Array.isArray(value) && Array.from(value).every(isSketchBoundaryEntityId)
  );
}

function requireSchema(document: ProjectDocument): void {
  if (
    typeof document.schemaVersion !== 'number' ||
    !Number.isSafeInteger(document.schemaVersion) ||
    document.schemaVersion < PROVENANCE_SCHEMA_VERSION
  )
    throw new Error(
      'Sketch boundary provenance and promotion ownership require project schema v37 or newer.'
    );
}

function profile(value: unknown, document: ProjectDocument): void {
  if (!record(value) || !('sourceBoundaryLoops' in value)) return;
  requireSchema(document);
  const known = new Set([
    'profileId',
    'regionFingerprint',
    'samplePoint',
    'sourceArea',
    'sourceEntityIds',
    'sourceBoundaryLoops',
    'all'
  ]);
  if (
    !isBoundaryProvenance(value.sourceBoundaryLoops) ||
    (value.all !== undefined && value.all !== false) ||
    !Number.isFinite(value.regionFingerprint) ||
    typeof value.sourceArea !== 'number' ||
    !Number.isFinite(value.sourceArea) ||
    value.sourceArea <= 0 ||
    !record(value.samplePoint) ||
    Object.keys(value.samplePoint).length !== 2 ||
    !Number.isFinite(value.samplePoint.x) ||
    !Number.isFinite(value.samplePoint.y) ||
    (value.profileId !== undefined &&
      (typeof value.profileId !== 'string' || !value.profileId)) ||
    (value.sourceEntityIds !== undefined &&
      (!Array.isArray(value.sourceEntityIds) ||
        !Array.from(value.sourceEntityIds).every(isSketchBoundaryEntityId))) ||
    !Object.keys(value).every((key) => known.has(key))
  )
    throw new Error(
      'Sketch profile boundary provenance or its geometric witness is malformed.'
    );
}

function section(value: unknown, document: ProjectDocument): void {
  if (record(value)) {
    profile(value, document);
    profile(value.profile, document);
  }
}

/** Only the model's known profile slots are inspected; metadata remains metadata. */
function featureProfiles(value: unknown, document: ProjectDocument): void {
  if (!record(value)) return;
  section(value.profile, document);
  if (Array.isArray(value.profiles))
    for (const candidate of value.profiles) profile(candidate, document);
  if (Array.isArray(value.sections))
    for (const candidate of value.sections) section(candidate, document);
}

/** Validate authored profile inputs without traversing unrelated history. */
export function assertFeatureProfileProvenance(
  value: unknown,
  document: ProjectDocument
): void {
  featureProfiles(value, document);
}

function sketch(
  value: Record<string, unknown>,
  document: ProjectDocument
): void {
  const promotions: SketchPromotion[] = [];
  if ('promotions' in value) {
    requireSchema(document);
    if (!Array.isArray(value.promotions))
      throw new Error('Sketch promotion records are malformed.');
    for (const candidate of value.promotions as unknown[]) {
      if (!isSketchPromotion(candidate))
        throw new Error('Sketch promotion records are malformed.');
      promotions.push(candidate);
    }
  }
  const owners = new Map<string, SketchPromotion>();
  const sources = new Set<string>();
  const members = new Set<string>();
  const ownedConstraints = new Set<string>();
  for (const promotion of promotions) {
    if (
      owners.has(promotion.promotionId) ||
      sources.has(promotion.sourceObjectId)
    )
      throw new Error(
        'Sketch promotions need unique promotion and source identities.'
      );
    owners.set(promotion.promotionId, promotion);
    sources.add(promotion.sourceObjectId);
    for (const id of [
      ...promotion.edgeIds,
      promotion.centerSpokeId,
      ...promotion.helperIds
    ]) {
      if (members.has(id))
        throw new Error(
          'A generated sketch member has more than one promotion owner.'
        );
      members.add(id);
    }
    for (const id of promotion.structureConstraintIds) {
      if (ownedConstraints.has(id))
        throw new Error(
          'A structural constraint has more than one promotion owner.'
        );
      ownedConstraints.add(id);
    }
  }
  const found = new Set<string>();
  if (Array.isArray(value.constraints))
    for (const constraint of value.constraints) {
      if (!record(constraint)) continue;
      const constraintData = constraint.data;
      if (
        record(constraintData) &&
        ['origin', 'promotionId'].some((key) => key in constraintData)
      ) {
        requireSchema(document);
        throw new Error(
          'Promotion ownership belongs on the constraint record, not its data payload.'
        );
      }
      const marked = 'origin' in constraint || 'promotionId' in constraint;
      if (marked) requireSchema(document);
      if (!marked && !ownedConstraints.has(String(constraint.constraintId)))
        continue;
      if (
        constraint.origin === 'user' &&
        constraint.promotionId === undefined &&
        !ownedConstraints.has(String(constraint.constraintId))
      )
        continue;
      const owner =
        typeof constraint.promotionId === 'string'
          ? owners.get(constraint.promotionId)
          : undefined;
      if (
        constraint.origin !== 'promotion-structure' ||
        !owner ||
        typeof constraint.constraintId !== 'string' ||
        !owner.structureConstraintIds.includes(
          constraint.constraintId as SketchPromotion['structureConstraintIds'][number]
        ) ||
        found.has(constraint.constraintId)
      )
        throw new Error(
          'Promotion structural constraints need a complete, unique promotion owner.'
        );
      const operands = promotionStructureObjectIds(constraint.data);
      const ownerMembers = new Set([
        ...owner.edgeIds,
        owner.centerSpokeId,
        ...owner.helperIds
      ]);
      if (!operands || operands.some((id) => !ownerMembers.has(id)))
        throw new Error(
          'Promotion structural constraints need legal payloads over their owned members.'
        );
      found.add(constraint.constraintId);
    }
  if (found.size !== ownedConstraints.size)
    throw new Error(
      'A sketch promotion is missing its owned structural constraints.'
    );
}

function replay(value: unknown, document: ProjectDocument): void {
  const pending: unknown[] = [value];
  const seen = new Set<object>();
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
    if (command.kind === 'transaction') {
      pending.push(command.payload);
      continue;
    }
    if (command.kind === 'sketch.legacy.convert') {
      requireSchema(document);
      conversionPayload(command.payload);
      continue;
    }
    if (command.kind === 'sketch.promotion.release') {
      requireSchema(document);
      if (
        !record(command.payload) ||
        Object.keys(command.payload).length !== 2 ||
        !isSketchBoundaryEntityId(command.payload.sketchId) ||
        !isSketchBoundaryEntityId(command.payload.promotionId)
      )
        throw new Error(
          'Promotion release replay needs its sketch and promotion identities.'
        );
      continue;
    }
    if (!record(command.payload)) continue;
    const payload = command.payload;
    if (
      command.kind === 'feature.extrude' ||
      command.kind === 'feature.loft' ||
      command.kind === 'feature.sweep' ||
      command.kind === 'feature.helical-sweep'
    )
      featureProfiles(command.payload, document);
    else if (command.kind === 'feature.update')
      featureProfiles(command.payload.data, document);
    else if (command.kind === 'sketch.constraint.add') {
      // Structural ownership belongs to a conversion record, never to an
      // arbitrary user constraint command's data payload.
      if (
        ['origin', 'promotionId'].some(
          (key) =>
            key in payload ||
            (record(payload.constraint) && key in payload.constraint)
        )
      ) {
        requireSchema(document);
        throw new Error(
          'Promotion structural ownership must be written by an explicit conversion command.'
        );
      }
    }
  }
}

function conversionPayload(value: unknown): void {
  const failure = () =>
    new Error(
      'Legacy conversion replay needs a complete source snapshot and preassigned identities.'
    );
  if (
    !record(value) ||
    !isSketchBoundaryEntityId(value.sketchId) ||
    !isSketchBoundaryEntityId(value.sourceObjectId) ||
    (value.expectedSource !== undefined &&
      !isLegacyCompositeObjectData(value.expectedSource)) ||
    !record(value.ids) ||
    Object.keys(value.ids).length !== 4 ||
    !isSketchBoundaryEntityId(value.ids.promotionId) ||
    !isSketchBoundaryEntityId(value.ids.centerSpokeId) ||
    !identities(value.ids.edgeIds) ||
    value.ids.edgeIds.length !== 64 ||
    !identities(value.ids.helperIds) ||
    value.ids.helperIds.length !== 1 ||
    !Object.keys(value).every((key) =>
      ['sketchId', 'sourceObjectId', 'expectedSource', 'ids'].includes(key)
    )
  )
    throw failure();
  const members = [
    value.sourceObjectId,
    ...value.ids.edgeIds,
    value.ids.centerSpokeId,
    ...value.ids.helperIds
  ];
  if (new Set(members).size !== members.length) throw failure();
}

/** Call after unreadable undo history has been removed by normalizeDocument. */
export function assertSketchProvenance(document: ProjectDocument): void {
  for (const node of documentNodesWithHistory(document)) {
    if (node.kind === 'sketch')
      sketch(node as unknown as Record<string, unknown>, document);
    else if (node.kind === 'feature') featureProfiles(node.data, document);
  }
  replay(document.commandLog, document);
  for (const entry of document.editHistory?.entries ?? [])
    for (const change of entry.changes)
      if (change.field === 'commandLog') {
        replay(change.before, document);
        replay(change.after, document);
      }
}
