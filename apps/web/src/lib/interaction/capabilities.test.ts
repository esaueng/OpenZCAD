import { describe, expect, it } from 'vitest';
import type { FaceTopologyReferenceV5, FeatureId } from '@openzcad/shared';
import { UNSTABLE_FACE_SKETCH_REASON } from '../faceSketchAttachment';
import { preferredCapability, selectionCapabilities } from './capabilities';

const reference = (currentHash: number): FaceTopologyReferenceV5 => ({
  kind: 'face',
  producingFeatureId: 'feature_box' as FeatureId,
  lineageName: 'primitive.box.face.z-max',
  currentHash,
  witnessVersion: 1,
  witness: {
    surfaceType: 'plane',
    perimeter: 40,
    centroid: [0, 0, 5],
    analytic: { kind: 'plane', normal: [0, 0, 1], offset: 5 },
    closure: { u: 'open', v: 'open' }
  }
});

describe('selectionCapabilities', () => {
  it('offers offset and sketch for a fingerprinted planar face', () => {
    const capabilities = selectionCapabilities({
      kind: 'face',
      target: { surfaceType: 'planar', hash: 12, reference: reference(12) }
    });
    expect(capabilities.map((capability) => capability.action)).toEqual([
      'offset-face',
      'sketch-on-face'
    ]);
    expect(preferredCapability(capabilities)?.action).toBe('offset-face');
  });

  it('keeps offset available but disables sketch for a hash-only planar face', () => {
    const capabilities = selectionCapabilities({
      kind: 'face',
      target: { surfaceType: 'planar', hash: 12 }
    });
    expect(capabilities[0]).toMatchObject({
      action: 'offset-face',
      enabled: true
    });
    expect(capabilities[1]).toMatchObject({
      action: 'sketch-on-face',
      enabled: false
    });
    // Compare against the constant, not a phrase from it: the wording is
    // user-facing copy and has already been rewritten once underneath these
    // assertions.
    expect(capabilities[1]?.disabledReason).toBe(UNSTABLE_FACE_SKETCH_REASON);
    expect(capabilities[1]?.disabledReason).toMatch(
      /sketch on a principal plane/i
    );
  });

  it('offers radial resize only for a measurable cylindrical face', () => {
    expect(
      selectionCapabilities({
        kind: 'face',
        target: { surfaceType: 'cylindrical', hash: 2, radius: 4 }
      }).map((capability) => capability.action)
    ).toEqual(['resize-radial-face']);
    expect(
      selectionCapabilities({
        kind: 'face',
        target: { surfaceType: 'cylindrical', hash: 2 }
      })
    ).toEqual([]);
  });

  it('prefers a producing fillet over generic cylinder resize', () => {
    const capabilities = selectionCapabilities({
      kind: 'face',
      target: {
        surfaceType: 'cylindrical',
        hash: 2,
        radius: 2,
        blendRadius: 2,
        filletFeatureId: 'feature_fillet' as FeatureId
      }
    });
    expect(capabilities.map((capability) => capability.action)).toEqual([
      'edit-fillet',
      'remove-fillet'
    ]);
    expect(preferredCapability(capabilities)?.action).toBe('edit-fillet');
  });

  it('does not treat an unbacked cylindrical blend as a generic radius edit', () => {
    expect(
      selectionCapabilities({
        kind: 'face',
        target: {
          surfaceType: 'cylindrical',
          hash: 2,
          radius: 2,
          blendRadius: 2
        }
      })
    ).toEqual([]);
  });

  it('offers exact resize and removal for an analytic imported blend', () => {
    const capabilities = selectionCapabilities({
      kind: 'face',
      target: {
        surfaceType: 'other',
        hash: 2,
        blendRadius: 2,
        canResizeImportedBlend: true
      }
    });
    expect(capabilities.map((capability) => capability.action)).toEqual([
      'edit-fillet',
      'remove-fillet'
    ]);
    expect(preferredCapability(capabilities)?.action).toBe('edit-fillet');
  });

  it('offers only a proven imported blend removal', () => {
    expect(
      selectionCapabilities({
        kind: 'face',
        target: {
          surfaceType: 'other',
          blendRadius: 1,
          canRemoveFaceFeature: true
        }
      }).map((capability) => capability.action)
    ).toEqual(['remove-face-feature']);
  });

  it('keeps a planar cap on the face-offset intent', () => {
    const capability = preferredCapability(
      selectionCapabilities({
        kind: 'face',
        target: { surfaceType: 'planar', hash: 3, reference: reference(3) }
      })
    );
    expect(capability?.action).toBe('offset-face');
    expect(capability?.action).not.toBe('resize-radial-face');
  });

  it('requires a same-body edge set and exposes both finishing actions', () => {
    expect(
      selectionCapabilities({ kind: 'edges', count: 3, sameBody: true }).map(
        (capability) => capability.action
      )
    ).toEqual(['fillet', 'chamfer']);
    expect(
      selectionCapabilities({ kind: 'edges', count: 2, sameBody: false })
    ).toEqual([]);
  });

  it('rejects empty or invalid regions', () => {
    expect(selectionCapabilities({ kind: 'region', area: 20 })[0]?.action).toBe(
      'extrude-region'
    );
    expect(selectionCapabilities({ kind: 'region', area: 0 })).toEqual([]);
  });
});
