/**
 * Turning a viewport profile selection into the references an extrude stores.
 *
 * Most selections become geometry-identity references: fingerprint, sample
 * point and area, which survive nudging a curve and fail closed when the
 * topology changes. One kind of selection must not. A text object's regions
 * change count, area, fingerprint and sample point together the moment the
 * string changes, so a geometry reference to one of its glyphs breaks on
 * exactly the edit the text feature exists to support — and breaks
 * *partially*, because a letter whose position did not move keeps resolving.
 * A half-updated model is worse than a refusal.
 *
 * So a selection whose source entities all carry their own outlines is stored
 * as `{ all: true, sourceEntityIds }` instead, which resolves by entity id and
 * nothing else. See `docs/plans/text-feature-plan.md` and
 * `resolveEntityProfiles` in `@openzcad/kernel-adapter`.
 */
import type { RegionPickData } from '@openzcad/viewport';
import type {
  SketchObjectData,
  SketchProfileReference
} from '@openzcad/shared';

/**
 * Object kinds whose profiles are matched by entity id rather than geometry.
 *
 * Deliberately a set and not `objectKind === 'text'`: anything that supplies
 * its own outlines instead of contributing curves to the arrangement belongs
 * here, and the resolver already treats them uniformly.
 */
const ENTITY_WIDE_OBJECT_KINDS: ReadonlySet<SketchObjectData['objectKind']> =
  new Set(['text']);

export function isEntityWideProfileSource(
  data: SketchObjectData | undefined
): boolean {
  return data !== undefined && ENTITY_WIDE_OBJECT_KINDS.has(data.objectKind);
}

/**
 * The key shared by every profile one entity-wide source supplies, or null
 * for a profile that is matched by its own geometry. Profiles with the same
 * key are built together whatever was picked, so they are picked together.
 */
export function entityWideSourceKey(
  sourceEntityIds: readonly string[],
  isEntityWideSource: (entityId: string) => boolean
): string | null {
  if (
    sourceEntityIds.length === 0 ||
    !sourceEntityIds.every(isEntityWideSource)
  ) {
    return null;
  }
  return [...sourceEntityIds].sort().join('|');
}

/**
 * The profiles a pick of `picked` stands for: every candidate from the same
 * entity-wide source (all the glyphs of one text object), or just the pick.
 */
export function profilesBuiltWith<
  T extends { sketchId: string; sourceEntityIds: string[] }
>(
  picked: T,
  candidates: readonly T[],
  isEntityWideSource: (entityId: string) => boolean
): T[] {
  const key = entityWideSourceKey(picked.sourceEntityIds, isEntityWideSource);
  if (key === null) {
    return [picked];
  }
  const group = candidates.filter(
    (candidate) =>
      candidate.sketchId === picked.sketchId &&
      entityWideSourceKey(candidate.sourceEntityIds, isEntityWideSource) === key
  );
  return group.length > 0 ? group : [picked];
}

/**
 * The references to persist for a profile selection.
 *
 * Selections over an entity-wide source collapse to one reference per source
 * entity, however many of its regions were picked — resolving the same entity
 * twice would hand the extrude the same profiles twice, which
 * `resolveRegionProfiles` rejects as a duplicate.
 */
export function profileReferencesForSelection(
  profiles: readonly RegionPickData[],
  isEntityWideSource: (entityId: string) => boolean
): SketchProfileReference[] {
  const references: SketchProfileReference[] = [];
  const seenEntitySets = new Set<string>();
  for (const profile of profiles) {
    const sourceEntityIds = profile.sourceEntityIds;
    // Sorted for the key and for the stored reference, so two selections
    // that name the same entities produce the same reference.
    const key = entityWideSourceKey(sourceEntityIds, isEntityWideSource);
    if (key !== null) {
      if (seenEntitySets.has(key)) {
        continue;
      }
      seenEntitySets.add(key);
      references.push({
        all: true,
        sourceEntityIds: [...sourceEntityIds].sort()
      });
      continue;
    }
    references.push({
      // A `legacy_` id is synthesized from a fingerprint by the drag path and
      // is not a real profile id, so it must not be persisted as one.
      ...(profile.profileId.startsWith('legacy_')
        ? {}
        : { profileId: profile.profileId }),
      regionFingerprint: profile.regionFingerprint,
      samplePoint: profile.samplePoint,
      sourceArea: profile.area,
      ...(sourceEntityIds.length > 0 ? { sourceEntityIds } : {})
    });
  }
  return references;
}
