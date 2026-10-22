import {
  commandFactories,
  type CommandDefinition
} from '@openzcad/command-system';
import {
  listFeaturesInOrder,
  type FeatureUpdateInput
} from '@openzcad/document-core';
import { GEOMETRY_LINEAR_TOLERANCE } from '@openzcad/geometry';
import {
  deepClone,
  isFeatureSuppressed,
  type EdgeVertexPointSource,
  type FeatureId,
  type FeatureNode,
  type ProjectDocument,
  type TopologySelection
} from '@openzcad/shared';
import { type DatumVertexRepairSession } from './datumPlaneDisplay';
import {
  datumVertexFromEdgePick,
  edgeEnds,
  requireResolvedDatums
} from './datumPlanes';
import { resolveEdge } from './topologyResolution';

export {
  beginDatumVertexRepair,
  datumVertexRepairSlots,
  datumVertexSourceFailed,
  type DatumVertexRepairSlot,
  type DatumVertexRepairSession
} from './datumPlaneDisplay';

function currentFeature(
  document: ProjectDocument,
  featureId: FeatureId
): FeatureNode {
  const feature = listFeaturesInOrder(document).find(
    (item) => item.featureId === featureId
  );
  if (!feature) throw new Error('The datum being repaired no longer exists.');
  return feature;
}

function assertCurrentSession(
  document: ProjectDocument,
  session: DatumVertexRepairSession
): FeatureNode {
  if (
    document.projectId !== session.projectId ||
    document.version !== session.documentVersion
  )
    throw new Error(
      'The document changed during vertex repair. Cancel and start the repair again.'
    );
  const feature = currentFeature(document, session.featureId);
  if (
    feature.name !== session.featureName ||
    isFeatureSuppressed(feature) ||
    JSON.stringify(feature.data) !== JSON.stringify(session.sourceData)
  )
    throw new Error(
      'The datum definition changed during vertex repair. Cancel and start again.'
    );
  return feature;
}

type Point = { x: number; y: number; z: number };

function qualifiedVertex(
  document: ProjectDocument,
  selection: TopologySelection,
  clickPoint: Point | null
): EdgeVertexPointSource {
  if (selection.kind !== 'edge')
    throw new Error('Click an open edge near the end vertex to use.');
  if (
    !clickPoint ||
    ![clickPoint.x, clickPoint.y, clickPoint.z].every(Number.isFinite)
  )
    throw new Error('Click near one end of the edge to choose a vertex.');
  const body = document.derived.bodyRepresentations[selection.bodyId];
  const edges = body?.topology?.edges;
  if (
    (selection.hash !== undefined &&
      edges?.filter((edge) => edge.hash === selection.hash).length !== 1) ||
    (selection.topologyId !== undefined &&
      edges?.filter((edge) => edge.topologyId === selection.topologyId)
        .length !== 1)
  )
    throw new Error(
      'The picked edge is missing or ambiguous. Pick a current edge again.'
    );
  const resolved = resolveEdge(body, selection);
  if (!resolved.ok)
    throw new Error(
      'The picked edge is missing or ambiguous. Pick a current edge again.'
    );
  const edge = resolved.entry;
  // The existing vertex picker lowers by hash. A topology-id or lineage-only
  // pick must establish that the current hash also identifies exactly one edge.
  if (edges?.filter((candidate) => candidate.hash === edge.hash).length !== 1)
    throw new Error(
      'The picked edge has an ambiguous identity. Pick another edge.'
    );
  const reference = edge.reference;
  if (
    !reference ||
    reference.kind !== 'edge' ||
    reference.witnessVersion !== 1 ||
    !reference.producingFeatureId ||
    !reference.lineageName ||
    reference.currentHash !== edge.hash ||
    (selection.hash !== undefined && selection.hash !== edge.hash) ||
    (selection.topologyId !== undefined &&
      selection.topologyId !== edge.topologyId)
  )
    throw new Error(
      'This edge has no current identity a rebuild can find again.'
    );
  if (reference.witness.closed)
    throw new Error('A closed edge has no end vertex; pick an open edge.');
  if (
    reference.witness.endpoints.length !== 2 ||
    !reference.witness.endpoints.every(
      (point) => point.length === 3 && point.every(Number.isFinite)
    )
  )
    throw new Error('This edge has no finite end vertices.');
  // Reject duplicate lineage even when a raw hash uniquely selected one edge.
  if (
    edges?.filter(
      (candidate) =>
        candidate.reference?.producingFeatureId ===
          reference.producingFeatureId &&
        candidate.reference.lineageName === reference.lineageName
    ).length !== 1
  )
    throw new Error(
      'The picked edge has ambiguous lineage. Pick another edge.'
    );
  const ends = edgeEnds(reference.witness)!;
  const distances = ends.map((point) =>
    Math.hypot(
      point.x - clickPoint.x,
      point.y - clickPoint.y,
      point.z - clickPoint.z
    )
  );
  if (
    !distances.every(Number.isFinite) ||
    Math.abs(distances[0]! - distances[1]!) <= GEOMETRY_LINEAR_TOLERANCE
  )
    throw new Error(
      'The click does not identify one end vertex. Click closer to the desired end.'
    );
  const source = datumVertexFromEdgePick(
    document,
    { ...selection, hash: edge.hash },
    clickPoint
  );
  if ('reason' in source) throw new Error(source.reason);
  return deepClone(source);
}

export function stageDatumVertexRepairPick(
  document: ProjectDocument,
  session: DatumVertexRepairSession,
  selection: TopologySelection,
  clickPoint: Point | null
): DatumVertexRepairSession {
  assertCurrentSession(document, session);
  if (!session.pendingSlot)
    throw new Error('Every requested vertex has already been picked.');
  const source = qualifiedVertex(document, selection, clickPoint);
  const replacements = [
    ...deepClone(session.replacements),
    { index: session.pendingSlot.index, source }
  ];
  const pendingSlot =
    session.slots.find(
      (slot) =>
        !replacements.some((replacement) => replacement.index === slot.index)
    ) ?? null;
  return {
    ...deepClone(session),
    replacements,
    pendingSlot: deepClone(pendingSlot)
  };
}

export function datumVertexRepairEdit(
  document: ProjectDocument,
  session: DatumVertexRepairSession
): {
  command: CommandDefinition<FeatureUpdateInput>;
  label: string;
  validateDerived(derived: ProjectDocument['derived']): void;
} {
  const feature = assertCurrentSession(document, session);
  if (
    session.pendingSlot ||
    session.replacements.length !== session.slots.length
  )
    throw new Error('Pick every requested vertex before applying the repair.');
  const data = deepClone(feature.data);
  for (const replacement of session.replacements) {
    if (
      data.featureKind === 'datum-plane' &&
      data.definition.kind === 'three-point'
    )
      data.definition.points[replacement.index] = deepClone(replacement.source);
    else if (
      data.featureKind === 'datum-plane' &&
      data.definition.kind === 'parallel-point'
    )
      data.definition.point = deepClone(replacement.source);
    else if (
      data.featureKind === 'datum-axis' &&
      data.definition.kind === 'two-point' &&
      replacement.index !== 2
    )
      data.definition.points[replacement.index] = deepClone(replacement.source);
    else
      throw new Error(
        'This datum does not have the requested vertex point role.'
      );
  }
  const label = `Re-pick ${session.slots.length === 1 ? 'vertex' : 'vertices'} for ${feature.name}`;
  const payload: FeatureUpdateInput = { featureId: feature.featureId, data };
  const command = commandFactories.updateFeature(deepClone(payload), label);
  const before = document;
  const pinnedSession = deepClone(session);
  return {
    label,
    command: {
      ...command,
      payload: deepClone(payload),
      validate: (current) => {
        assertCurrentSession(current, pinnedSession);
        commandFactories
          .updateFeature(deepClone(payload), label)
          .validate(current);
      },
      apply: (current) => {
        assertCurrentSession(current, pinnedSession);
        return commandFactories
          .updateFeature(deepClone(payload), label)
          .apply(current);
      },
      serialize: () => deepClone(command.serialize())
    },
    validateDerived: (derived) =>
      requireResolvedDatums(before, derived, feature.featureId, feature.name)
  };
}
