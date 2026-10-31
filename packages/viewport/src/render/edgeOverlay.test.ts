import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import {
  toBodyId,
  toFeatureId,
  type EdgeTopologyReferenceV5,
  type TopologySelection
} from '@openzcad/shared';
import {
  EDGE_IDLE_COLOR,
  EDGE_IDLE_OPACITY,
  EDGE_IDLE_WIDTH,
  EDGE_SELECTED_COLOR,
  EDGE_SELECTED_WIDTH,
  EDGE_WIREFRAME_COLOR
} from '../pick/edges';
import { SELECTION_SEMANTICS } from './semantics';
import { createBodyEdgeOverlay } from './edgeOverlay';
import { FAT_LINE_DEPTH_BIAS_RATIO } from './scene';
import { applyDisplayMode } from '../scene/objects';

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
 * Runs the tiers' x-ray twins to rest. The visible batches cut in the frame
 * the pointer arrives or the click lands; only the twins behind the solid
 * ease, and the render loop steps them.
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
  it('keeps X-ray batches visible through the generic shaded display pass', () => {
    const overlay = makeOverlay();
    const root = new THREE.Group();
    root.add(overlay);
    overlay.setDisplayMode('shaded');
    overlay.setXrayView(true);
    applyDisplayMode(root, 'shaded');
    expect(overlay.idleEdges.visible).toBe(true);
  });

  it('consolidates all renderable polylines into one idle draw batch', () => {
    const overlay = makeOverlay();

    expect(overlay.idleEdges.geometry.instanceCount).toBe(3);
    expect(overlay.ownershipBySegment).toEqual([
      {
        bodyId: BODY_ID,
        topologyId: 'edge-a',
        hash: 11,
        reference: EDGE_REFERENCE,
        // Carried for picking: an inside-corner edge wins a click on the face
        // it bounds only if the batch knows which faces those are.
        adjacentFaceHashes: [101]
      },
      {
        bodyId: BODY_ID,
        topologyId: 'edge-a',
        hash: 11,
        reference: EDGE_REFERENCE,
        adjacentFaceHashes: [101]
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
    settle(overlay);
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

  it('cuts the selected tier in at full width on the frame the click lands', () => {
    const overlay = makeOverlay();
    const idleWidth = overlay.idleEdges.material.linewidth;

    overlay.setSelected([selection('edge-a')]);
    // Selection is a state change: no step has run, and the line is already
    // drawn at selection width. Only its x-ray twin has a ramp to play.
    expect(overlay.selectedEdges.visible).toBe(true);
    expect(overlay.selectedEdges.material.opacity).toBe(1);
    expect(overlay.selectedEdges.material.linewidth).toBe(EDGE_SELECTED_WIDTH);
    expect(overlay.selectedHiddenEdges.material.opacity).toBe(0);
    expect(overlay.selectedHiddenEdges.material.linewidth).toBe(idleWidth);

    expect(overlay.step(16)).toBe(true);
    const midHidden = overlay.selectedHiddenEdges.material.opacity;
    expect(midHidden).toBeGreaterThan(0);
    expect(overlay.selectedEdges.material.opacity).toBe(1);

    settle(overlay);
    expect(overlay.selectedHiddenEdges.material.opacity).toBeGreaterThan(
      midHidden
    );
    expect(overlay.selectedHiddenEdges.material.opacity).toBeLessThan(1);
    expect(overlay.selectedEdges.material.linewidth).toBe(EDGE_SELECTED_WIDTH);
  });

  it("lets an edge's x-ray twin begin visibly on a slow frame, then land", () => {
    const overlay = makeOverlay();
    // A software renderer draws one frame per ~400 ms while another
    // animation keeps the loop running on real elapsed time. The twin's
    // first step after a new target is capped, so its ramp is seen; the next
    // frame advances by the real gap and lands it.
    overlay.setSelected([selection('edge-a')]);
    overlay.step(400);
    const first = overlay.selectedHiddenEdges.material.opacity;
    expect(first).toBeGreaterThan(0);
    overlay.step(400);
    expect(overlay.selectedHiddenEdges.material.opacity).toBeGreaterThan(first);
    expect(overlay.step(400)).toBe(false);
  });

  it("cuts a selected face's rim on and off, easing only its x-ray twin", () => {
    const overlay = makeOverlay();

    overlay.setSelectedFaceBoundary(101);
    expect(
      overlay.selectedFaceBoundaryEdges.geometry.instanceCount
    ).toBeGreaterThan(0);
    expect(overlay.selectedFaceBoundaryEdges.visible).toBe(true);
    expect(overlay.selectedFaceBoundaryEdges.material.opacity).toBe(1);
    expect(overlay.selectedFaceBoundaryEdges.material.linewidth).toBe(
      SELECTION_SEMANTICS.selected.boundaryWidth
    );
    expect(overlay.selectedFaceBoundaryHiddenEdges.material.opacity).toBe(0);

    settle(overlay);
    expect(overlay.selectedFaceBoundaryHiddenEdges.visible).toBe(true);

    overlay.setSelectedFaceBoundary(null);
    // The rim itself is gone on the same frame; its twin behind the solid
    // keeps the positions until its fade-out has played.
    expect(overlay.selectedFaceBoundaryEdges.visible).toBe(false);
    expect(overlay.selectedFaceBoundaryEdges.material.opacity).toBe(0);
    expect(overlay.selectedFaceBoundaryHiddenEdges.visible).toBe(true);
    expect(
      overlay.selectedFaceBoundaryHiddenEdges.geometry.instanceCount
    ).toBeGreaterThan(0);
    settle(overlay);
    expect(overlay.selectedFaceBoundaryHiddenEdges.visible).toBe(false);
    expect(overlay.selectedFaceBoundaryEdges.geometry.instanceCount).toBe(0);
  });

  it('cuts the selected line off but holds its geometry for the x-ray fade-out', () => {
    const overlay = makeOverlay();
    overlay.setSelected([selection('edge-a')]);
    settle(overlay);

    overlay.setSelected([]);
    expect(overlay.selectedEdges.visible).toBe(false);
    expect(overlay.selectedEdges.material.opacity).toBe(0);
    // Dropping the positions on the clearing frame would make the twin's
    // fade-out invisible: the tier has to outlive the selection it is losing.
    expect(overlay.selectedHiddenEdges.visible).toBe(true);
    expect(overlay.selectedHiddenEdges.geometry.instanceCount).toBeGreaterThan(
      0
    );

    settle(overlay);
    expect(overlay.selectedHiddenEdges.material.opacity).toBe(0);
    expect(overlay.selectedHiddenEdges.visible).toBe(false);
    expect(overlay.selectedEdges.geometry.instanceCount).toBe(0);
  });

  it('lets go of a cleared tier at once when its twin has nothing to fade', () => {
    const overlay = makeOverlay();
    overlay.setSelected([selection('edge-a')]);
    // Deselected before any frame ran: the twin never rose, so there is no
    // fade-out to hold geometry for, and nothing to keep the loop awake.
    overlay.setSelected([]);
    expect(overlay.selectedEdges.geometry.instanceCount).toBe(0);
    expect(overlay.selectedEdges.visible).toBe(false);
    expect(overlay.selectedHiddenEdges.visible).toBe(false);
    expect(overlay.step(16)).toBe(false);
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
    // Select an edge too — otherwise the width comparison below reads
    // against an idle-width selected tier and stops saying anything about
    // the rim being the wider of the two.
    overlay.setSelected([selection('edge-a')]);
    settle(overlay);

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

  it('draws every edge in the wireframe ink in X-ray, even when shaded', () => {
    const overlay = makeOverlay();
    const material = overlay.idleEdges.material;
    overlay.setDisplayMode('shaded');
    expect(overlay.idleEdges.visible).toBe(false);

    expect(overlay.setXrayView(true)).toBe(true);
    expect(overlay.setXrayView(true)).toBe(false);
    expect(overlay.idleEdges.material).toBe(material);
    expect(overlay.idleEdges.visible).toBe(true);
    expect(material.color.getHex()).toBe(EDGE_WIREFRAME_COLOR);
    expect(material.opacity).toBe(1);

    // Leaving X-ray puts back exactly the mode that was chosen.
    overlay.setXrayView(false);
    expect(overlay.idleEdges.visible).toBe(false);
    overlay.setDisplayMode('shaded-edges');
    expect(material.color.getHex()).toBe(EDGE_IDLE_COLOR);
    expect(material.opacity).toBe(EDGE_IDLE_OPACITY);
  });

  it('outlines a selected body by restyling its idle batch in place', () => {
    const overlay = makeOverlay();
    const idleMaterial = overlay.idleEdges.material;
    const idleGeometry = overlay.idleEdges.geometry;

    expect(overlay.setBodySelected(true)).toBe(true);
    expect(overlay.setBodySelected(true)).toBe(false);
    expect(idleMaterial.color.getHex()).toBe(EDGE_SELECTED_COLOR);
    expect(idleMaterial.linewidth).toBe(
      SELECTION_SEMANTICS.selected.bodyEdgeWidth
    );
    expect(idleMaterial.opacity).toBe(1);
    // Same batch objects: the outline must not cost a rebuild.
    expect(overlay.idleEdges.material).toBe(idleMaterial);
    expect(overlay.idleEdges.geometry).toBe(idleGeometry);

    // A display-mode change keeps the outline, and clearing the selection
    // restores that mode's idle look rather than the shaded one.
    overlay.setDisplayMode('wireframe');
    expect(idleMaterial.color.getHex()).toBe(EDGE_SELECTED_COLOR);
    expect(overlay.setBodySelected(false)).toBe(true);
    expect(idleMaterial.color.getHex()).toBe(EDGE_WIREFRAME_COLOR);
    expect(idleMaterial.linewidth).toBe(EDGE_IDLE_WIDTH);
    expect(idleMaterial.opacity).toBe(1);
    overlay.setDisplayMode('shaded-edges');
    expect(idleMaterial.color.getHex()).toBe(EDGE_IDLE_COLOR);
    expect(idleMaterial.opacity).toBe(EDGE_IDLE_OPACITY);
  });

  it('suppresses only hidden passes for receded sketch solids', () => {
    const overlay = makeOverlay();
    overlay.setSelected([selection('edge-b')]);
    overlay.setHovered(overlay.ownerAtSegment(0));
    overlay.setSelectedFaceBoundary(101);
    settle(overlay);

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

/**
 * `instanceCount` lives on `InstancedBufferGeometry`, which is what a
 * `LineSegments2` carries — reading it through the plain `BufferGeometry` a
 * `Mesh` declares does not typecheck.
 */
function instanceCountOf(line: THREE.Object3D): number {
  const geometry = (line as THREE.Mesh)
    .geometry as THREE.InstancedBufferGeometry;
  return geometry.instanceCount;
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
describe('BodyEdgeOverlay.suspendHighlights', () => {
  it('draws no selection or hover styling until restored, then restores it exactly', () => {
    const overlay = makeOverlay();
    overlay.setSelected([selection('edge-a')]);
    overlay.setSelectedFaceBoundary(101);
    overlay.setHovered({ bodyId: BODY_ID, topologyId: 'edge-b', hash: 13 });
    overlay.setBodySelected(true);
    settle(overlay);
    const visibleNames = () =>
      overlay.children
        .filter((child) => child.visible)
        .map((child) => child.name)
        .sort();
    const material = overlay.idleEdges.material;
    const before = {
      names: visibleNames(),
      color: material.color.getHex(),
      linewidth: material.linewidth,
      opacity: material.opacity
    };
    expect(before.names).toContain('body-edge-selected');
    expect(before.names).toContain('body-face-boundary-selected');

    const restore = overlay.suspendHighlights();
    expect(visibleNames()).toEqual(['body-edge']);
    const plain = makeOverlay().idleEdges.material;
    expect(material.color.getHex()).toBe(plain.color.getHex());
    expect(material.linewidth).toBe(plain.linewidth);

    restore();
    expect({
      names: visibleNames(),
      color: material.color.getHex(),
      linewidth: material.linewidth,
      opacity: material.opacity
    }).toEqual(before);
  });
});

describe('BodyEdgeOverlay allocation', () => {
  const AUXILIARY = [
    'body-edge-hover',
    'body-edge-hover-hidden',
    'body-edge-selected',
    'body-edge-selected-hidden',
    'body-face-boundary-selected',
    'body-face-boundary-selected-hidden'
  ];

  it.each(['hover', 'selection', 'face boundary'] as const)(
    'releases old %s buffers before growth and reuses capacity afterward',
    (tier) => {
      const overlay = makeOverlay();
      const lines =
        tier === 'hover'
          ? [overlay.hoverEdges, overlay.hoverHiddenEdges]
          : tier === 'selection'
            ? [overlay.selectedEdges, overlay.selectedHiddenEdges]
            : [
                overlay.selectedFaceBoundaryEdges,
                overlay.selectedFaceBoundaryHiddenEdges
              ];
      const geometries = lines.map((line) => line.geometry);
      const released = geometries.map(() => [] as unknown[]);
      geometries.forEach((geometry, index) => {
        geometry.addEventListener('dispose', () => {
          released[index]!.push(geometry.getAttribute('instanceStart'));
        });
      });
      const initial = geometries.map((geometry) =>
        geometry.getAttribute('instanceStart')
      );
      const show = (long: boolean) => {
        if (tier === 'hover') {
          overlay.setHovered({
            bodyId: BODY_ID,
            topologyId: long ? 'edge-a' : 'edge-b',
            hash: long ? 11 : 13
          });
        } else if (tier === 'selection') {
          overlay.setSelected([selection(long ? 'edge-a' : 'edge-b')]);
        } else {
          // A face with no boundary clears the tier without changing capacity.
          overlay.setSelectedFaceBoundary(long ? 101 : null);
        }
        settle(overlay);
      };

      show(false);
      show(true);
      lines.forEach((line, index) => {
        expect(line.geometry).toBe(geometries[index]);
        // The renderer must see the outgoing attributes during disposal,
        // otherwise their GPU buffers survive the replacement.
        expect(released[index]).toEqual([initial[index]]);
        expect(line.geometry.getAttribute('instanceStart')).not.toBe(
          initial[index]
        );
        expect(line.geometry.instanceCount).toBe(2);
      });
      const grown = geometries.map((geometry) =>
        geometry.getAttribute('instanceStart')
      );
      show(false);
      show(true);
      lines.forEach((line, index) => {
        expect(released[index]).toHaveLength(1);
        expect(line.geometry.getAttribute('instanceStart')).toBe(grown[index]);
      });
    }
  );

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

    expect(instanceBufferFloats(selected)).toBeGreaterThan(before);
    expect(instanceCountOf(selected)).toBe(400 * 7);
    settle(overlay);
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
    expect(instanceCountOf(selected)).toBe(7);
  });
});

describe('edge overlay depth and x-ray rendering', () => {
  function fatLines(overlay: THREE.Object3D) {
    const lines: THREE.Mesh<THREE.BufferGeometry, LineMaterial>[] = [];
    overlay.traverse((child) => {
      if ((child as THREE.Mesh).material instanceof LineMaterial) {
        lines.push(child as THREE.Mesh<THREE.BufferGeometry, LineMaterial>);
      }
    });
    return lines;
  }

  it('pulls every edge line toward the camera by a fraction of the body extent', () => {
    // An edge and its neighbouring faces are tessellated separately, so on a
    // curved neighbour the edge's chords sit just behind the face's. Without
    // the bias the depth test hid stretches of a selected rim; the fixture's
    // points span 3 units, the bias follows that span.
    const overlay = makeOverlay();
    const lines = fatLines(overlay);

    expect(lines).toHaveLength(8);
    for (const line of lines) {
      expect(line.material.uniforms.depthBias?.value, line.name).toBeCloseTo(
        3 * FAT_LINE_DEPTH_BIAS_RATIO
      );
    }
  });

  it('draws the x-ray twins once per pixel and leaves the visible tiers alone', () => {
    // Translucent segments overlap at every joint; blended twice there, a
    // hidden edge read as a row of beads. Alpha to coverage at a third of
    // full opacity left only those beads. The faint tangent batch is
    // translucent for the same reason.
    const lines = fatLines(makeOverlay());
    const onceEach = (line: (typeof lines)[number]) =>
      line.name.endsWith('-hidden') || line.name === 'body-edge-tangent';
    const hidden = lines.filter(onceEach);
    const visible = lines.filter((line) => !onceEach(line));

    expect(hidden.map((line) => line.name).sort()).toEqual([
      'body-edge-hover-hidden',
      'body-edge-selected-hidden',
      'body-edge-tangent',
      'body-face-boundary-selected-hidden'
    ]);
    for (const line of hidden) {
      expect(line.material.stencilWrite, line.name).toBe(true);
      expect(line.material.stencilFunc, line.name).toBe(
        THREE.NotEqualStencilFunc
      );
      expect(line.material.stencilZPass, line.name).toBe(
        THREE.ReplaceStencilOp
      );
      // Bit 1 is the opaque bodies' coverage; the twins must not touch it.
      expect(line.material.stencilWriteMask & 1, line.name).toBe(0);
      expect(line.material.alphaToCoverage, line.name).toBe(false);
    }
    for (const line of visible) {
      expect(line.material.stencilWrite, line.name).toBe(false);
      expect(line.material.alphaToCoverage, line.name).toBe(true);
    }
  });
});
