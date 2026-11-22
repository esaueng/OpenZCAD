import { describe, expect, it } from 'vitest';
import type { BodyId } from '@openzcad/shared';
import { measurementHighlightTargets } from './measureHighlights';
import type { MeasurementTarget } from './measurements';

const target = (
  kind: MeasurementTarget['kind'],
  extra: Partial<MeasurementTarget> = {}
): MeasurementTarget => ({
  bodyId: 'body-1' as BodyId,
  bodyName: 'Block',
  kind,
  label: 'Block',
  semantic: 'pick',
  quality: 'exact-analytic',
  ...extra
});

describe('measurement hover highlights (M13)', () => {
  it('lights each measured edge and face by identity, and no whole body', () => {
    expect(
      measurementHighlightTargets({
        targets: [
          target('edge', { topologyId: 'edge:3', hash: 33 }),
          target('face', { topologyId: 'face:1' }),
          target('body')
        ]
      })
    ).toEqual([
      { bodyId: 'body-1', kind: 'edge', topologyId: 'edge:3', hash: 33 },
      { bodyId: 'body-1', kind: 'face', topologyId: 'face:1' }
    ]);
  });

  it('carries the lineage reference, so the viewer resolves as Measure does', () => {
    const reference = { kind: 'edge' } as never;
    expect(
      measurementHighlightTargets({
        targets: [target('edge', { topologyId: 'edge:3', hash: 33, reference })]
      })[0]
    ).toMatchObject({ reference });
  });
});
