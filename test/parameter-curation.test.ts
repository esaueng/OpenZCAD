import { describe, expect, it } from 'vitest';
import {
  createProjectDocument,
  listExposedParameters,
  listParameters,
  setParameter,
  setParameterDescription,
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

describe('parameter descriptions', () => {
  it('stores a gloss for whoever meets the model through a share link', () => {
    const document = setParameterDescription(documentWithParameters(), {
      name: 'width',
      description: 'Overall width across the mounting flanges'
    });
    expect(
      listParameters(document).find((p) => p.name === 'width')?.description
    ).toBe('Overall width across the mounting flanges');
  });

  it('trims, and clears rather than storing an empty string', () => {
    // "No description" needs one representation, or the panel has to test for
    // both absent and blank before deciding whether to render a line.
    let document = setParameterDescription(documentWithParameters(), {
      name: 'width',
      description: '  Overall width  '
    });
    expect(
      listParameters(document).find((p) => p.name === 'width')?.description
    ).toBe('Overall width');
    document = setParameterDescription(document, {
      name: 'width',
      description: '   '
    });
    expect(
      listParameters(document).find((p) => p.name === 'width')
    ).not.toHaveProperty('description');
  });

  it('survives curation and expression edits', () => {
    let document = setParameterDescription(documentWithParameters(), {
      name: 'width',
      description: 'Overall width'
    });
    document = setParameterExposed(document, { name: 'width', exposed: true });
    document = setParameter(document, { name: 'width', expression: '45' });
    document = setParameterExposed(document, { name: 'width', exposed: false });
    expect(
      listParameters(document).find((p) => p.name === 'width')?.description
    ).toBe('Overall width');
  });

  it('refuses to describe a parameter that does not exist', () => {
    expect(() =>
      setParameterDescription(documentWithParameters(), {
        name: 'nope',
        description: 'x'
      })
    ).toThrow(/does not exist/);
  });

  it('describes under its own command kind, not parameter.set', () => {
    // Same reasoning as curation: a Tweak visitor may turn the knobs, but
    // must not rewrite what the owner said they mean.
    expect(
      commandFactories.setParameterDescription({
        name: 'width',
        description: 'Overall width'
      }).kind
    ).toBe('parameter.describe');
  });
});
