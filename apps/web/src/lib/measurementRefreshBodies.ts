import type { BodyRepresentation, ProjectDocument } from '@openzcad/shared';

/** Exact committed bodies that may authoritatively refresh persisted rows. */
export function committedMeasurementBodies(
  bodyRepresentations: ProjectDocument['derived']['bodyRepresentations']
): BodyRepresentation[] {
  return Object.values(bodyRepresentations).filter((body) => !body.consumed);
}
