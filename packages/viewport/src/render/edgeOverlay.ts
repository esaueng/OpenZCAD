import * as THREE from 'three';
import type { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import type {
  BodyRepresentation,
  EdgeTopologyReferenceV5,
  TopologySelection
} from '@openzcad/shared';
import {
  EDGE_HOVER_COLOR,
  EDGE_HOVER_WIDTH,
  EDGE_IDLE_COLOR,
  EDGE_IDLE_OPACITY,
  EDGE_IDLE_WIDTH,
  EDGE_SELECTED_COLOR,
  EDGE_SELECTED_WIDTH,
  EDGE_WIREFRAME_COLOR
} from '../pick/edges';
import { shouldRenderTopologyEdge } from '../scene/objects';
import type { DisplayMode } from '../types';
import {
  createFatLineSegments,
  type FatLineResolution,
  VIEWPORT_RENDER_ORDER
} from './scene';

/** Stable topology identity carried by every segment in an idle edge batch. */
export interface EdgeSegmentOwner {
  bodyId: TopologySelection['bodyId'];
  topologyId: string;
  hash: number;
  reference?: EdgeTopologyReferenceV5;
}

interface EdgeEntry {
  owner: EdgeSegmentOwner;
  /** Disjoint xyz/xyz pairs consumed by LineSegmentsGeometry. */
  positions: number[];
}

interface EdgeBatchUserData {
  edgeBatch?: BodyEdgeOverlay;
}

export interface BatchedEdgeTarget {
  batch: BodyEdgeOverlay;
  owner: EdgeSegmentOwner;
}

const EMPTY_SEGMENT = [0, 0, 0, 0, 0, 0] as const;

function edgeKey(owner: Pick<EdgeSegmentOwner, 'bodyId' | 'topologyId'>) {
  return `${owner.bodyId}:${owner.topologyId}`;
}

/** Converts a connected xyz polyline into disjoint xyz/xyz segment pairs. */
function segmentsFromPolyline(points: readonly number[]): number[] {
  const positions: number[] = [];
  const pointCount = Math.floor(points.length / 3);
  for (let pointIndex = 0; pointIndex + 1 < pointCount; pointIndex += 1) {
    const start = pointIndex * 3;
    const end = start + 3;
    positions.push(
      points[start]!,
      points[start + 1]!,
      points[start + 2]!,
      points[end]!,
      points[end + 1]!,
      points[end + 2]!
    );
  }
  return positions;
}

function replacePositions(line: LineSegments2, positions: readonly number[]) {
  const instanceStart = line.geometry.getAttribute('instanceStart');
  if (!(instanceStart instanceof THREE.InterleavedBufferAttribute)) {
    throw new Error('Edge overlay is missing its instance position buffer.');
  }
  const storage = instanceStart.data.array;
  if (positions.length > storage.length) {
    throw new Error('Edge overlay position capacity was exceeded.');
  }
  storage.fill(0);
  storage.set(positions);
  instanceStart.data.needsUpdate = true;
  line.geometry.instanceCount = positions.length / 6;
  line.geometry.computeBoundingBox();
  line.geometry.computeBoundingSphere();
  line.visible = positions.length > 0;
}

function sameKeys(left: ReadonlySet<string>, right: ReadonlySet<string>) {
  return (
    left.size === right.size &&
    [...left].every((candidate) => right.has(candidate))
  );
}

/**
 * One body's exact edge display.
 *
 * All resting topology edges share `idleEdges`, which caps their resting
 * rendering at one draw call. Hover and committed selection use two stable,
 * normally hidden batches whose geometry attributes are updated in place;
 * changing selection never touches the body's face geometry or materials.
 */
export class BodyEdgeOverlay extends THREE.Group {
  readonly idleEdges: LineSegments2;
  readonly hoverEdges: LineSegments2;
  readonly selectedEdges: LineSegments2;
  /** Raycast segment index to exact topology identity. */
  readonly ownershipBySegment: readonly EdgeSegmentOwner[];

  private readonly bodyId: TopologySelection['bodyId'];
  private readonly entriesByKey = new Map<string, EdgeEntry>();
  private selectedKeys = new Set<string>();
  private hoveredKey: string | null = null;
  private displayMode: DisplayMode = 'shaded-edges';

  constructor(
    body: Pick<BodyRepresentation, 'bodyId' | 'topology'>,
    resolution?: FatLineResolution
  ) {
    super();
    this.bodyId = body.bodyId;
    this.name = 'body-edge-overlay';
    this.userData.bodyId = this.bodyId;

    const idlePositions: number[] = [];
    const ownership: EdgeSegmentOwner[] = [];
    for (const edge of body.topology?.edges ?? []) {
      if (!shouldRenderTopologyEdge(edge)) {
        continue;
      }
      const owner: EdgeSegmentOwner = {
        bodyId: body.bodyId,
        topologyId: edge.topologyId,
        hash: edge.hash,
        ...(edge.reference ? { reference: edge.reference } : {})
      };
      const positions = segmentsFromPolyline(edge.points);
      if (positions.length === 0) {
        continue;
      }
      this.entriesByKey.set(edgeKey(owner), { owner, positions });
      idlePositions.push(...positions);
      const segmentCount = positions.length / 6;
      for (let index = 0; index < segmentCount; index += 1) {
        ownership.push(owner);
      }
    }
    this.ownershipBySegment = ownership;

    this.idleEdges = createFatLineSegments(
      idlePositions.length > 0 ? idlePositions : EMPTY_SEGMENT,
      {
        color: EDGE_IDLE_COLOR,
        linewidth: EDGE_IDLE_WIDTH,
        opacity: EDGE_IDLE_OPACITY,
        resolution
      }
    );
    this.idleEdges.name = 'body-edge';
    this.idleEdges.renderOrder = VIEWPORT_RENDER_ORDER.BODY_EDGE;
    this.idleEdges.visible = idlePositions.length > 0;
    this.idleEdges.userData = {
      bodyId: body.bodyId,
      // `prioritizeVisibleEdgeHit` deliberately recognizes this as an edge;
      // PickService then resolves the individual segment through the batch.
      topologyKind: 'edge',
      edgeBatch: this,
      ownershipBySegment: this.ownershipBySegment
    };

    this.hoverEdges = this.createOverlay(
      'body-edge-hover',
      EDGE_HOVER_COLOR,
      EDGE_HOVER_WIDTH,
      VIEWPORT_RENDER_ORDER.HOVER_HIGHLIGHT,
      Math.max(
        EMPTY_SEGMENT.length,
        ...[...this.entriesByKey.values()].map(
          (entry) => entry.positions.length
        )
      ),
      resolution
    );
    this.selectedEdges = this.createOverlay(
      'body-edge-selected',
      EDGE_SELECTED_COLOR,
      EDGE_SELECTED_WIDTH,
      VIEWPORT_RENDER_ORDER.SELECTED_GEOMETRY,
      Math.max(EMPTY_SEGMENT.length, idlePositions.length),
      resolution
    );
    this.add(this.idleEdges, this.hoverEdges, this.selectedEdges);
  }

  private createOverlay(
    name: string,
    color: THREE.ColorRepresentation,
    linewidth: number,
    renderOrder: number,
    positionCapacity: number,
    resolution?: FatLineResolution
  ) {
    const overlay = createFatLineSegments(new Array(positionCapacity).fill(0), {
      color,
      linewidth,
      opacity: 1,
      resolution
    });
    overlay.name = name;
    overlay.visible = false;
    overlay.renderOrder = renderOrder;
    overlay.userData = { bodyId: this.bodyId, edgeOverlay: true };
    // The resting batch is authoritative for picking. Otherwise one selected
    // edge would appear twice in pickAll and break select-other depth cycling.
    overlay.raycast = () => undefined;
    return overlay;
  }

  ownerAtSegment(segmentIndex: number | null | undefined) {
    return typeof segmentIndex === 'number'
      ? (this.ownershipBySegment[segmentIndex] ?? null)
      : null;
  }

  /** Updates all committed edge highlights while keeping the batch objects. */
  setSelected(selections: readonly TopologySelection[]) {
    const nextKeys = new Set(
      selections
        .filter(
          (selection) =>
            selection.kind === 'edge' &&
            selection.topologyId !== undefined &&
            selection.bodyId === this.bodyId
        )
        .map((selection) => edgeKey(selection as EdgeSegmentOwner))
        .filter((key) => this.entriesByKey.has(key))
    );
    if (sameKeys(this.selectedKeys, nextKeys)) {
      return false;
    }
    this.selectedKeys = nextKeys;
    const positions = [...this.entriesByKey]
      .filter(([key]) => nextKeys.has(key))
      .flatMap(([, entry]) => entry.positions);
    replacePositions(this.selectedEdges, positions);
    this.refreshVisibility();
    return true;
  }

  /** Moves the single reusable hover batch to one exact edge. */
  setHovered(owner: EdgeSegmentOwner | null) {
    const candidateKey = owner?.bodyId === this.bodyId ? edgeKey(owner) : null;
    const nextKey =
      candidateKey && this.entriesByKey.has(candidateKey) ? candidateKey : null;
    if (this.hoveredKey === nextKey) {
      return false;
    }
    this.hoveredKey = nextKey;
    const entry = nextKey ? this.entriesByKey.get(nextKey) : undefined;
    replacePositions(this.hoverEdges, entry?.positions ?? []);
    this.refreshVisibility();
    return true;
  }

  /** Applies CAD display mode without rebuilding any edge batch. */
  setDisplayMode(mode: DisplayMode) {
    this.displayMode = mode;
    for (const line of [this.idleEdges, this.hoverEdges, this.selectedEdges]) {
      line.userData.displayMode = mode;
    }
    this.idleEdges.material.color.setHex(
      mode === 'wireframe' ? EDGE_WIREFRAME_COLOR : EDGE_IDLE_COLOR
    );
    this.idleEdges.material.opacity =
      mode === 'wireframe' ? 1 : EDGE_IDLE_OPACITY;
    this.refreshVisibility();
  }

  /** Keeps all three stable fat-line materials correct after a resize. */
  setResolution(resolution: FatLineResolution) {
    for (const line of [this.idleEdges, this.hoverEdges, this.selectedEdges]) {
      line.material.resolution.set(
        Math.max(resolution.width, 1),
        Math.max(resolution.height, 1)
      );
    }
  }

  private refreshVisibility() {
    const showEdges = this.displayMode !== 'shaded';
    this.idleEdges.visible = showEdges && this.ownershipBySegment.length > 0;
    this.selectedEdges.visible = showEdges && this.selectedKeys.size > 0;
    this.hoverEdges.visible =
      showEdges &&
      this.hoveredKey !== null &&
      !this.selectedKeys.has(this.hoveredKey);
  }
}

export function createBodyEdgeOverlay(
  body: Pick<BodyRepresentation, 'bodyId' | 'topology'>,
  resolution?: FatLineResolution
) {
  return new BodyEdgeOverlay(body, resolution);
}

/** Resolves a LineSegments2 raycast hit back to its owning exact edge. */
export function batchedEdgeTarget(
  object: THREE.Object3D,
  segmentIndex: number | null | undefined
): BatchedEdgeTarget | null {
  const batch = (object.userData as EdgeBatchUserData).edgeBatch;
  const owner = batch?.ownerAtSegment(segmentIndex);
  return batch && owner ? { batch, owner } : null;
}

export function isSameBatchedEdge(
  left: BatchedEdgeTarget,
  right: BatchedEdgeTarget
) {
  return (
    left.batch === right.batch &&
    left.owner.bodyId === right.owner.bodyId &&
    left.owner.topologyId === right.owner.topologyId
  );
}
