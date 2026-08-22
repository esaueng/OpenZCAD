import { describe, expect, it } from 'vitest';
import {
  createProjectDocument,
  listExposedParameters,
  listParameters,
  setParameter,
  setParameterExposed
} from '@openzcad/document-core';
import { commandFactories } from '@openzcad/command-system';
import { toUserId } from '@openzcad/shared';

function documentWithParameters() {
  let document = createProjectDocument('Curated', toUserId('user_test'), 'mm');
  document = setParameter(document, { name: 'width', expression: '30' });
  document = setParameter(document, { name: 'height', expression: '10' });
  document = setParameter(document, { name: 'wall', expression: 'width / 10' });
  return document;
}

describe('curated parameters', () => {
  it('offers every parameter until one is chosen', () => {
    // An uncurated model — including every model authored before curation
    // existed — must keep behaving the way it did, or sharing one would
    // silently publish an empty panel.
    const document = documentWithParameters();
    expect(listExposedParameters(document).map((p) => p.name)).toEqual([
      'width',
      'height',
      'wall'
    ]);
  });

  it('offers exactly the chosen ones once any is chosen', () => {
    const document = setParameterExposed(documentWithParameters(), {
      name: 'width',
      exposed: true
    });
    expect(listExposedParameters(document).map((p) => p.name)).toEqual([
      'width'
    ]);
  });

  it('keeps parameterOrder, not the order they were chosen in', () => {
    let document = documentWithParameters();
    document = setParameterExposed(document, { name: 'wall', exposed: true });
    document = setParameterExposed(document, { name: 'width', exposed: true });
    expect(listExposedParameters(document).map((p) => p.name)).toEqual([
      'width',
      'wall'
    ]);
  });

  it('falls back to offering everything when the last choice is undone', () => {
    let document = documentWithParameters();
    document = setParameterExposed(document, { name: 'width', exposed: true });
    document = setParameterExposed(document, { name: 'width', exposed: false });
    expect(listExposedParameters(document)).toHaveLength(3);
  });

  it('survives an expression edit', () => {
    // Curation is a property of the parameter, not of its current value.
    let document = setParameterExposed(documentWithParameters(), {
      name: 'width',
      exposed: true
    });
    document = setParameter(document, { name: 'width', expression: '45' });
    expect(listExposedParameters(document).map((p) => p.name)).toEqual([
      'width'
    ]);
    expect(
      listParameters(document).find((p) => p.name === 'width')?.value
    ).toBe(45);
  });

  it('refuses to curate a parameter that does not exist', () => {
    expect(() =>
      setParameterExposed(documentWithParameters(), {
        name: 'nope',
        exposed: true
      })
    ).toThrow(/does not exist/);
  });

  it('curates under its own command kind, not parameter.set', () => {
    // Load-bearing: Tweak mode's guard admits `parameter.set` so a visitor
    // can turn the published knobs. If curation rode on that command, the
    // same visitor could publish knobs the owner never offered.
    expect(
      commandFactories.setParameterExposed({ name: 'width', exposed: true })
        .kind
    ).toBe('parameter.expose');
    expect(
      commandFactories.setParameter({ name: 'width', expression: '30' }).kind
    ).toBe('parameter.set');
  });
});
