import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { BodyRepresentation } from '@openzcad/shared';
import { LabelSegments } from './LabelSegments';
import { setLiveDiameter } from '../lib/liveLabels';
import {
  topologySelectionLabel,
  topologySelectionLabelSegments
} from '../lib/topologyLabels';

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
    faceCount: 1,
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
        }
      ],
      edges: []
    }
  };
}

const SELECTION = { kind: 'face' as const, hash: 1 };

/**
 * The selection chip renders through React while the viewport callout is built
 * by hand; both must expose the same live-value node, or the chip freezes
 * mid-drag the way the old text-matching update did.
 */
describe('LabelSegments', () => {
  it('takes the live diameter the drag pushes into it', () => {
    const body = makeBody(28);
    const { container } = render(
      <span className="selection-chip-label">
        <LabelSegments
          segments={topologySelectionLabelSegments(body, SELECTION)}
        />
      </span>
    );
    const chip = container.firstElementChild!;
    expect(chip.textContent).toBe(topologySelectionLabel(body, SELECTION));

    setLiveDiameter(chip, 36);
    expect(chip.textContent).toBe(
      topologySelectionLabel(makeBody(36), SELECTION)
    );

    setLiveDiameter(chip, null);
    expect(chip.textContent).toBe(topologySelectionLabel(body, SELECTION));
  });
});
