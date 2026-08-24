import { describe, expect, it } from 'vitest';
import type { BodyRepresentation } from '@openzcad/shared';
import { renderLabelSegments, setLiveDiameter } from './liveLabels';
import {
  faceLabel,
  faceLabelSegments,
  labelSegmentsText,
  topologySelectionLabel,
  topologySelectionLabelSegments
} from './topologyLabels';

/** Two faces that carry a diameter through different `faceLabel` branches. */
function makeBody(diameter: number): BodyRepresentation {
  return {
    bodyId: 'body-1' as BodyRepresentation['bodyId'],
    name: 'Cylinder1',
    source: 'primitive',
    mesh: {
      kind: 'mesh',
      vertices: Float32Array.from([]),
      indices: Uint32Array.from([])
    },
    faceCount: 2,
    color: '#fff',
    exportableStep: true,
    consumed: false,
    volume: 1000,
    bbox: {
      min: { x: -10, y: -10, z: 0 },
      max: { x: 10, y: 10, z: 20 }
    },
    topology: {
      faces: [
        {
          topologyId: 'face:wall',
          hash: 1,
          triangleStart: 0,
          triangleCount: 2,
          geometry: {
            surfaceType: 'cylinder',
            area: 50,
            center: { x: 0, y: 0, z: 10 },
            radius: diameter / 2,
            diameter
          }
        },
        {
          topologyId: 'face:bore',
          hash: 2,
          triangleStart: 2,
          triangleCount: 2,
          geometry: {
            surfaceType: 'cylinder',
            area: 20,
            center: { x: 0, y: 0, z: 10 },
            radius: diameter / 2,
            diameter,
            featureType: 'through-hole'
          }
        }
      ],
      edges: []
    }
  };
}

const WALL = 1;
const BORE = 2;

describe('live label values', () => {
  function render(segments: Parameters<typeof renderLabelSegments>[1]) {
    const element = document.createElement('div');
    renderLabelSegments(element, segments);
    return element;
  }

  it('keeps the segmented and rendered forms of a name in step', () => {
    const body = makeBody(28);
    for (const hash of [WALL, BORE]) {
      expect(labelSegmentsText(faceLabelSegments(body, hash))).toBe(
        faceLabel(body, hash)
      );
      expect(render(faceLabelSegments(body, hash)).textContent).toBe(
        faceLabel(body, hash)
      );
    }
    const selection = { kind: 'face' as const, hash: WALL };
    expect(
      render(topologySelectionLabelSegments(body, selection)).textContent
    ).toBe(topologySelectionLabel(body, selection));
  });

  /**
   * The live value used to be found by matching the rendered text against one
   * hard-coded wording, so it moved for `Cylindrical face Ø28` and silently
   * froze for every other name carrying a diameter. Asserting against
   * `faceLabel` of the dragged body ties the check to the derived value rather
   * than to today's wording: rewording a name moves both sides together.
   */
  it('shows the dragged diameter whatever the name around it says', () => {
    const document28 = makeBody(28);
    const dragged36 = makeBody(36);
    for (const hash of [WALL, BORE]) {
      const element = render(faceLabelSegments(document28, hash));
      setLiveDiameter(element, 36);
      expect(element.textContent).toBe(faceLabel(dragged36, hash));
    }
  });

  it('rewrites the value under wording no label uses today', () => {
    const element = render([
      { kind: 'text', text: 'Reworded bore, diameter ' },
      { kind: 'diameter', diameter: 28 },
      { kind: 'text', text: ' (as built)' }
    ]);
    setLiveDiameter(element, 36);
    expect(element.textContent).toBe('Reworded bore, diameter Ø36 (as built)');
  });

  it('restores the document value when the drag ends', () => {
    const body = makeBody(28);
    const element = render(
      topologySelectionLabelSegments(body, {
        kind: 'face',
        hash: WALL
      })
    );
    setLiveDiameter(element, 36);
    setLiveDiameter(element, null);
    expect(element.textContent).toBe(
      topologySelectionLabel(body, { kind: 'face', hash: WALL })
    );
  });

  it('leaves names with no live value alone', () => {
    const body = makeBody(28);
    body.topology!.faces[0]!.geometry = {
      surfaceType: 'plane',
      area: 100,
      center: { x: 0, y: 0, z: 20 },
      normal: { x: 0, y: 0, z: 1 }
    };
    const element = render(faceLabelSegments(body, WALL));
    setLiveDiameter(element, 36);
    expect(element.textContent).toBe('Top face');
  });
});
