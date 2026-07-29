import { describe, expect, it } from 'vitest';
import { preferredCapability, selectionCapabilities } from './capabilities';

describe('selectionCapabilities', () => {
  it('offers offset and sketch for a fingerprinted planar face', () => {
    const capabilities = selectionCapabilities({
      kind: 'face',
      target: { surfaceType: 'planar', hash: 12 }
    });
    expect(capabilities.map((capability) => capability.action)).toEqual([
      'offset-face',
      'sketch-on-face'
    ]);
    expect(preferredCapability(capabilities)?.action).toBe('offset-face');
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

  it('keeps a planar cap on the face-offset intent', () => {
    const capability = preferredCapability(
      selectionCapabilities({
        kind: 'face',
        target: { surfaceType: 'planar', hash: 3 }
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
