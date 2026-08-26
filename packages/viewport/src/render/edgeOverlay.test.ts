import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  toBodyId,
  toFeatureId,
  type EdgeTopologyReferenceV5,
  type TopologySelection
} from '@openzcad/shared';
import {
  EDGE_IDLE_COLOR,
  EDGE_IDLE_OPACITY,
  EDGE_WIREFRAME_COLOR
} from '../pick/edges';
import { createBodyEdgeOverlay } from './edgeOverlay';

const BODY_ID = toBodyId('body-1');
const EDGE_REFERENCE: EdgeTopologyReferenceV5 = {
  kind: 'edge',
  producingFeatureId: toFeatureId('feature-1'),
  lineageName: 'primitive:edge:a',
  currentHash: 11,
  witnessVersion: 1,
  witness: {
    curveType: 'line',
    length: 2,
    closed: false,
    endpoints: [
      [0, 0, 0],
      [2_000_000, 0, 0]
    ],
    midpoint: [1_000_000, 0, 0]
  }
};

function makeOverlay() {
  return createBodyEdgeOverlay(
    {
      bodyId: BODY_ID,
      topology: {
        faces: [
          {
            topologyId: 'face-a',
            hash: 101,
            triangleStart: 0,
            triangleCount: 1
          }
        ],
        edges: [
          {
            topologyId: 'edge-a',
            hash: 11,
            reference: EDGE_REFERENCE,
            adjacentFaceHashes: [101],
            points: [0, 0, 0, 1, 0, 0, 2, 0, 0]
          },
          {
            topologyId: 'edge-seam',
            hash: 12,
            displayRole: 'seam',
            adjacentFaceHashes: [101],
            points: [0, 1, 0, 1, 1, 0]
          },
          {
            topologyId: 'edge-b',
            hash: 13,
            points: [0, 2, 0, 1, 2, 0]
          },
          {
            topologyId: 'edge-short',
            hash: 14,
            points: [0, 3, 0]
          }
        ]
      }
    },
    { width: 800, height: 600 }
  );
}

/**
 * Runs the hover ramp to rest. Hover is eased now, so a batch is not visible
 * on the frame the pointer arrives — the render loop steps it.
 */
function settle(overlay: ReturnType<typeof makeOverlay>) {
  for (let frame = 0; frame < 60 && overlay.step(16); frame += 1) {
    // stepping until it reports nothing left to move
  }
}

function selection(topologyId: string): TopologySelection {
  return { bodyId: BODY_ID, kind: 'edge', topologyId };
}

describe('BodyEdgeOverlay', () => {
  it('consolidates all renderable polylines into one idle draw batch', () => {
    const overlay = makeOverlay();

    expect(overlay.idleEdges.geometry.instanceCount).toBe(3);
    expect(overlay.ownershipBySegment).toEqual([
      {
        bodyId: BODY_ID,
        topologyId: 'edge-a',
        hash: 11,
        reference: EDGE_REFERENCE
      },
      {
        bodyId: BODY_ID,
        topologyId: 'edge-a',
        hash: 11,
        reference: EDGE_REFERENCE
      },
      { bodyId: BODY_ID, topologyId: 'edge-b', hash: 13 }
    ]);
    expect(
      overlay.children
        .filter((child) => child.visible)
        .map((child) => child.name)
    ).toEqual(['body-edge']);
  });

  it('resolves every segment to its edge while excluding seams', () => {
    const overlay = makeOverlay();

    expect(overlay.ownerAtSegment(0)?.topologyId).toBe('edge-a');
    expect(overlay.ownerAtSegment(1)?.topologyId).toBe('edge-a');
    expect(overlay.ownerAtSegment(2)?.topologyId).toBe('edge-b');
    expect(overlay.ownerAtSegment(3)).toBeNull();
    expect(
      overlay.ownershipBySegment.some(
        (owner) => owner.topologyId === 'edge-seam'
      )
    ).toBe(false);
  });

  it('mutates reusable selection geometry without rebuilding body batches', () => {
    const overlay = makeOverlay();
    const idleGeometry = overlay.idleEdges.geometry;
    const idleMaterial = overlay.idleEdges.material;
    const selectedGeometry = overlay.selectedEdges.geometry;
    const selectedMaterial = overlay.selectedEdges.material;

    expect(
      overlay.setSelected([selection('edge-a'), selection('edge-b')])
    ).toBe(true);
    expect(overlay.selectedEdges.geometry.instanceCount).toBe(3);
    expect(overlay.selectedHiddenEdges.geometry.instanceCount).toBe(3);
    expect(overlay.selectedEdges.visible).toBe(true);
    expect(overlay.selectedHiddenEdges.visible).toBe(true);
    expect(overlay.selectedHiddenEdges.material.depthFunc).toBe(
      THREE.GreaterDepth
    );
    expect(overlay.selectedHiddenEdges.material.opacity).toBeLessThan(
      overlay.selectedEdges.material.opacity
    );
    expect(overlay.idleEdges.geometry).toBe(idleGeometry);
    expect(overlay.idleEdges.material).toBe(idleMaterial);
    expect(overlay.selectedEdges.geometry).toBe(selectedGeometry);
    expect(overlay.selectedEdges.material).toBe(selectedMaterial);

    expect(overlay.setSelected([selection('edge-b')])).toBe(true);
    expect(overlay.selectedEdges.geometry.instanceCount).toBe(1);
    expect(overlay.setSelected([selection('edge-b')])).toBe(false);
  });

  it('does not draw a sentinel for filtered or unknown selections', () => {
    const overlay = makeOverlay();

    expect(
      overlay.setSelected([
        selection('edge-seam'),
        selection('edge-does-not-exist')
      ])
    ).toBe(false);
    expect(overlay.selectedEdges.visible).toBe(false);
  });

  it('keeps every reusable batch empty until something needs it', () => {
    const overlay = makeOverlay();
    const reusable = [
      overlay.hoverEdges,
      overlay.hoverHiddenEdges,
      overlay.selectedEdges,
      overlay.selectedHiddenEdges,
      overlay.selectedFaceBoundaryEdges,
      overlay.selectedFaceBoundaryHiddenEdges
    ];

    for (const line of reusable) {
      expect(line.geometry.instanceCount).toBe(0);
    }
    // Installing a body applies the display mode, which recomputes visibility
    // from those counts. A capacity-sized count here drew the body's whole
    // edge set as zero-length segments on every body in the scene.
    overlay.setDisplayMode('shaded-edges');
    for (const line of reusable) {
      expect(line.visible).toBe(false);
    }
    expect(
      overlay.children
        .filter((child) => child.visible)
        .map((child) => child.name)
    ).toEqual(['body-edge']);
  });

  it('uses one reusable hover batch and suppresses it for selected edges', () => {
    const overlay = makeOverlay();
    const hoverGeometry = overlay.hoverEdges.geometry;
    const owner = overlay.ownerAtSegment(0)!;

    overlay.setHovered(owner);
    settle(overlay);
    expect(overlay.hoverEdges.visible).toBe(true);
    expect(overlay.hoverHiddenEdges.visible).toBe(true);
    expect(overlay.hoverEdges.geometry.instanceCount).toBe(2);
    expect(overlay.hoverEdges.geometry).toBe(hoverGeometry);

    overlay.setSelected([selection('edge-a')]);
    expect(overlay.hoverEdges.visible).toBe(false);
    expect(overlay.hoverHiddenEdges.visible).toBe(false);

    overlay.setSelected([]);
    settle(overlay);
    expect(overlay.hoverEdges.visible).toBe(true);
    overlay.setHovered(null);
    settle(overlay);
    expect(overlay.hoverEdges.visible).toBe(false);
  });

  it('renders a smooth hover run in the same reusable batch', () => {
    const overlay = makeOverlay();
    const hoverGeometry = overlay.hoverEdges.geometry;

    overlay.setHovered(overlay.ownerAtSegment(0), ['edge-a', 'edge-b']);

    expect(overlay.hoverEdges.geometry).toBe(hoverGeometry);
    expect(overlay.hoverEdges.geometry.instanceCount).toBe(3);
  });

  it('draws a brighter face-boundary tier without seams in shaded mode', () => {
    const overlay = makeOverlay();

    expect(overlay.setSelectedFaceBoundary(101)).toBe(true);
    overlay.setDisplayMode('shaded');

    expect(overlay.selectedFaceBoundaryEdges.visible).toBe(true);
    expect(overlay.selectedFaceBoundaryHiddenEdges.visible).toBe(true);
    expect(overlay.selectedFaceBoundaryEdges.geometry.instanceCount).toBe(2);
    expect(
      overlay.selectedFaceBoundaryEdges.material.linewidth
    ).toBeGreaterThan(overlay.selectedEdges.material.linewidth);
    const intersections: THREE.Intersection[] = [];
    expect(
      overlay.selectedFaceBoundaryEdges.raycast(
        new THREE.Raycaster(),
        intersections
      )
    ).toBeUndefined();
    expect(intersections).toEqual([]);
  });

  it('changes wireframe and hidden visuals without replacing materials', () => {
    const overlay = makeOverlay();
    const material = overlay.idleEdges.material;
    overlay.setSelected([selection('edge-b')]);
    overlay.setHovered(overlay.ownerAtSegment(0));
    settle(overlay);

    overlay.setDisplayMode('wireframe');
    expect(overlay.idleEdges.material).toBe(material);
    expect(material.color.getHex()).toBe(EDGE_WIREFRAME_COLOR);
    expect(material.opacity).toBe(1);
    expect(overlay.idleEdges.visible).toBe(true);
    expect(overlay.selectedEdges.visible).toBe(true);
    expect(overlay.hoverEdges.visible).toBe(true);

    overlay.setDisplayMode('shaded');
    expect(overlay.idleEdges.visible).toBe(false);
    expect(overlay.selectedEdges.visible).toBe(false);
    expect(overlay.hoverEdges.visible).toBe(false);

    overlay.setDisplayMode('shaded-edges');
    expect(material.color.getHex()).toBe(EDGE_IDLE_COLOR);
    expect(material.opacity).toBe(EDGE_IDLE_OPACITY);
    expect(overlay.idleEdges.visible).toBe(true);
  });

  it('suppresses only hidden passes for receded sketch solids', () => {
    const overlay = makeOverlay();
    overlay.setSelected([selection('edge-b')]);
    overlay.setHovered(overlay.ownerAtSegment(0));
    settle(overlay);
    overlay.setSelectedFaceBoundary(101);

    expect(overlay.setXrayEnabled(false)).toBe(true);
    expect(overlay.selectedEdges.visible).toBe(true);
    expect(overlay.hoverEdges.visible).toBe(true);
    expect(overlay.selectedFaceBoundaryEdges.visible).toBe(true);
    expect(overlay.selectedHiddenEdges.visible).toBe(false);
    expect(overlay.hoverHiddenEdges.visible).toBe(false);
    expect(overlay.selectedFaceBoundaryHiddenEdges.visible).toBe(false);
  });

  it('updates every stable material resolution together', () => {
    const overlay = makeOverlay();
    overlay.setResolution({ width: 1440, height: 900 });

    for (const line of [
      overlay.idleEdges,
      overlay.hoverEdges,
      overlay.hoverHiddenEdges,
      overlay.selectedEdges,
      overlay.selectedHiddenEdges,
      overlay.selectedFaceBoundaryEdges,
      overlay.selectedFaceBoundaryHiddenEdges
    ]) {
      expect(line.material.resolution.x).toBe(1440);
      expect(line.material.resolution.y).toBe(900);
    }
  });
});

/**
 * A body of `edgeCount` straight edges, each a `pointCount`-point polyline.
 * Large enough that per-batch allocation is the dominant cost.
 */
function largeOverlay(edgeCount: number, pointCount: number) {
  return createBodyEdgeOverlay(
    {
      bodyId: BODY_ID,
      topology: {
        faces: [],
        edges: Array.from({ length: edgeCount }, (_, index) => ({
          topologyId: `edge-${index}`,
          hash: 1_000 + index,
          points: Array.from(
            { length: pointCount * 3 },
            (_, component) => (index * 7 + component) % 50
          )
        }))
      }
    },
    { width: 800, height: 600 }
  );
}

function instanceBufferFloats(line: THREE.Object3D): number {
  const geometry = (line as THREE.Mesh).geometry;
  const attribute = geometry.getAttribute('instanceStart');
  return attribute instanceof THREE.InterleavedBufferAttribute
    ? attribute.data.array.length
    : 0;
}

/**
 * The six hover/selection batches used to be born at the body's entire idle
 * edge count so `replacePositions` could never overflow — seven full-size
 * buffers per body, six of which draw nothing until the user hovers or selects
 * something. Measured on a 20k-edge import (an ordinary mid-size STEP): 115 MB
 * across seven equal batches and 338 ms on the main thread, with 98 MB of that
 * idle. They start empty now and grow to what is actually drawn.
 */
describe('BodyEdgeOverlay allocation', () => {
  const AUXILIARY = [
    'body-edge-hover',
    'body-edge-hover-hidden',
    'body-edge-selected',
    'body-edge-selected-hidden',
    'body-face-boundary-selected',
    'body-face-boundary-selected-hidden'
  ];

  it('does not size the hover and selection batches to the whole body', () => {
    const overlay = largeOverlay(2_000, 20);
    const idle = instanceBufferFloats(overlay.idleEdges);
    expect(idle).toBeGreaterThan(100_000);

    for (const name of AUXILIARY) {
      const batch = overlay.children.find((child) => child.name === name);
      expect(batch, name).toBeDefined();
      // Two orders of magnitude below the idle batch, not equal to it.
      expect(instanceBufferFloats(batch!), name).toBeLessThan(idle / 100);
    }
  });

  it('grows a batch to hold a selection larger than its capacity', () => {
    const overlay = largeOverlay(400, 8);
    const selected = overlay.children.find(
      (child) => child.name === 'body-edge-selected'
    )!;
    const before = instanceBufferFloats(selected);

    overlay.setSelected(
      Array.from({ length: 400 }, (_, index) => selection(`edge-${index}`))
    );

    const geometry = (selected as THREE.Mesh).geometry;
    expect(instanceBufferFloats(selected)).toBeGreaterThan(before);
    expect(geometry.instanceCount).toBe(400 * 7);
    expect(selected.visible).toBe(true);
  });

  it('reuses the grown buffer for a smaller selection instead of shrinking', () => {
    // Capacity ratchets to the high-water mark, so repeatedly changing the
    // selection does not reallocate on every change.
    const overlay = largeOverlay(400, 8);
    const selected = overlay.children.find(
      (child) => child.name === 'body-edge-selected'
    )!;

    overlay.setSelected(
      Array.from({ length: 400 }, (_, index) => selection(`edge-${index}`))
    );
    const grown = instanceBufferFloats(selected);

    overlay.setSelected([selection('edge-0')]);
    expect(instanceBufferFloats(selected)).toBe(grown);
    const geometry = (selected as THREE.Mesh).geometry;
    expect(geometry.instanceCount).toBe(7);
  });
});
