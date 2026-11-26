import { describe, expect, it } from 'vitest';
import type {
  BodyId,
  FeatureId,
  FeatureWarning,
  ProjectDocument
} from '@openzcad/shared';
import {
  bodyCommandClick,
  mirrorRefusalMember,
  refusedMirrorMember,
  type MirrorSetMember
} from './mirrorBodies';
import { IN_PLACE_TOOL_SPECS, inPlaceBodyMode } from './tools';

describe('bodyCommandClick', () => {
  const click = (
    tool: 'mirror' | 'split' | 'union' | 'subtract',
    overrides: Partial<Parameters<typeof bodyCommandClick>[0]> = {}
  ) => {
    const spec = IN_PLACE_TOOL_SPECS[tool];
    return bodyCommandClick({
      wantsPlane: Boolean(spec.wantsPlane),
      bodyMode: inPlaceBodyMode(spec, {}),
      additive: false,
      bodiesPicked: 1,
      onFace: true,
      previewResult: false,
      ...overrides
    });
  };

  it('Mirror: a plain click on a face with a body picked is the plane', () => {
    expect(click('mirror')).toBe('plane');
    // No body yet: the face names its body.
    expect(click('mirror', { bodiesPicked: 0 })).toBe('body');
  });

  it('Mirror: Shift toggles the clicked body, and adds nothing on a preview', () => {
    expect(click('mirror', { additive: true })).toBe('body');
    expect(click('mirror', { additive: true, previewResult: true })).toBe(
      'none'
    );
  });

  it('Mirror edit and Split take one body: Shift on a face is still the plane', () => {
    const spec = IN_PLACE_TOOL_SPECS.mirror;
    expect(
      bodyCommandClick({
        wantsPlane: true,
        bodyMode: inPlaceBodyMode(spec, {}, true),
        additive: true,
        bodiesPicked: 1,
        onFace: true,
        previewResult: false
      })
    ).toBe('plane');
    expect(click('split', { additive: true })).toBe('plane');
  });

  // Regression (review of #2247): Shift on a Boolean's preview result names
  // its first operand, as it did before Mirror took several bodies.
  it.each(['union', 'subtract'] as const)(
    '%s: Shift on its preview result still reaches the first pick',
    (tool) => {
      expect(
        click(tool, { additive: true, previewResult: true, bodiesPicked: 2 })
      ).toBe('body');
      expect(click(tool, { additive: true, bodiesPicked: 2 })).toBe('body');
      expect(click(tool, { bodiesPicked: 2 })).toBe('body');
    }
  );
});

describe('refusedMirrorMember', () => {
  const member = (n: number): MirrorSetMember => ({
    sourceBodyId: `body_src_${n}` as BodyId,
    featureId: `feat_${n}` as FeatureId,
    featureName: n === 1 ? 'Mirror' : `Mirror ${n}`,
    resultBodyId: `body_out_${n}` as BodyId
  });
  const members = [member(1), member(2), member(3)];
  const derived = (
    built: number[],
    warnings: FeatureWarning[] = []
  ): ProjectDocument['derived'] =>
    ({
      bodyRepresentations: Object.fromEntries(
        built.map((n) => [`body_out_${n}`, {}])
      ),
      warnings: warnings.map((warning) => warning.message),
      featureWarnings: warnings
    }) as unknown as ProjectDocument['derived'];
  const warning = (
    n: number,
    kind: FeatureWarning['kind']
  ): FeatureWarning => ({
    featureId: `feat_${n}` as FeatureId,
    featureName: `Mirror ${n}`,
    kind,
    message: `Feature "Mirror ${n}": anything at all.`
  });

  it('is null when every body mirrored', () => {
    expect(refusedMirrorMember(members, derived([1, 2, 3]))).toBeNull();
    // An advisory is usable geometry, not a refusal.
    expect(
      refusedMirrorMember(members, derived([1, 2, 3], [warning(2, 'advisory')]))
    ).toBeNull();
  });

  it('finds the refused body by its feature, whatever the wording', () => {
    expect(
      refusedMirrorMember(
        members,
        derived([1, 2, 3], [warning(2, 'build-failed')])
      )
    ).toBe(members[1]);
    expect(
      refusedMirrorMember(members, derived([1, 2, 3], [warning(3, 'refusal')]))
    ).toBe(members[2]);
  });

  it('a body that made no result is refused', () => {
    expect(refusedMirrorMember(members, derived([1, 3]))).toBe(members[1]);
  });

  it('names only the body whose feature the shown refusal is', () => {
    const failed = derived([1, 3], [warning(2, 'build-failed')]);
    // An earlier feature's warning leads: no picked body is blamed.
    expect(
      mirrorRefusalMember(members, failed, {
        featureId: 'feat_place' as FeatureId
      })
    ).toBeNull();
    expect(mirrorRefusalMember(members, failed, 'unattributed')).toBeNull();
    expect(
      mirrorRefusalMember(members, failed, { featureId: 'feat_2' as FeatureId })
    ).toBe(members[1]);
    // The set's own check refused, with no warning shown.
    expect(mirrorRefusalMember(members, derived([1, 3]), null)).toBe(
      members[1]
    );
  });
});
