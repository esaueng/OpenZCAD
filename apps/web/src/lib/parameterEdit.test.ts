import { describe, expect, it } from 'vitest';
import {
  CommandManager,
  commandFactories,
  growingHolderCommand
} from '@openzcad/command-system';
import {
  createProjectDocument,
  deleteParameter,
  setParameter
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import {
  parameterMinimums,
  parameterInputError,
  parameterBuildError,
  parameterUntouchedSince
} from './parameterEdit';

function holder() {
  const manager = new CommandManager(
    createProjectDocument('Height guard', toUserId('local'))
  );
  manager.execute(
    commandFactories.importStep({
      name: 'Source',
      artifactId: 'source',
      sourceName: 'source.step',
      stepText: 'synthetic'
    })
  );
  const section = [
    { objectKind: 'line' as const, x1: 0, y1: 0, x2: 1, y2: 0 },
    { objectKind: 'line' as const, x1: 1, y1: 0, x2: 0, y2: 1 },
    { objectKind: 'line' as const, x1: 0, y1: 1, x2: 0, y2: 0 }
  ];
  manager.execute(
    growingHolderCommand(manager.document, {
      version: 1,
      name: 'Holder',
      targetBodyId: manager.document.bodyOrder[0]!,
      axis: 'x',
      envelope: { min: { x: 0, y: 0, z: 0 }, max: { x: 60, y: 30, z: 58 } },
      cuts: [12, 48],
      center: 30,
      sourceOpening: 44,
      minimumOpening: 8.1,
      parameter: 'opening_width',
      section,
      height: {
        axis: 'z',
        cuts: [20, 21.189496],
        sourceHeight: 58,
        minimumHeight: 56.910504,
        parameter: 'holder_height',
        sections: { negative: section, positive: section }
      }
    }).command
  );
  return manager.document;
}

describe('parameter edit validation', () => {
  it('rejects a height below the measured limit without mutating the base', () => {
    const base = holder();
    const copy = structuredClone(base);
    expect(parameterMinimums(base).holder_height).toBe(56.910504);
    for (const expression of ['50', '55', '56.910503']) {
      expect(
        parameterInputError(
          base,
          setParameter(base, { name: 'holder_height', expression })
        )
      ).toContain('must be at least 56.910504');
    }
    for (const expression of ['56.910504', '58', '65'])
      expect(
        parameterInputError(
          base,
          setParameter(base, { name: 'holder_height', expression })
        )
      ).toBeNull();
    expect(base).toEqual(copy);
  });
  it('checks driving aliases and permits recovery from an already invalid saved height', () => {
    let base = setParameter(holder(), { name: 'driver', expression: '58' });
    base = setParameter(base, { name: 'holder_height', expression: 'driver' });
    expect(
      parameterInputError(
        base,
        setParameter(base, { name: 'driver', expression: '55' })
      )
    ).toContain('holder_height');
    base = setParameter(base, { name: 'holder_height', expression: '55' });
    expect(
      parameterInputError(
        base,
        setParameter(base, { name: 'holder_height', expression: '58' })
      )
    ).toBeNull();
  });
  it('refuses invalid expressions and failed dependent rebuilds, while allowing existing advisories', () => {
    const base = holder();
    expect(
      parameterInputError(
        base,
        setParameter(base, { name: 'holder_height', expression: 'missing' })
      )
    ).toBeTruthy();
    base.derived.warnings = ['Imported source advisory'];
    expect(
      parameterBuildError(base, {
        ...base.derived,
        warnings: ['Imported source advisory']
      })
    ).toBeNull();
    expect(
      parameterBuildError(base, {
        ...base.derived,
        warnings: ['Imported source advisory', 'Final union failed']
      })
    ).toBe('Final union failed');
    base.derived.exportableBodyIds = [base.bodyOrder.at(-1)!];
    expect(
      parameterBuildError(base, { ...base.derived, bodyRepresentations: {} })
    ).toContain('existing result body');
  });

  it('allows a new advisory delta while refusing a migrated same-text failure', () => {
    const base = holder();
    base.derived.warnings = [];
    base.derived.featureWarnings = [];
    // A new advisory (overlap merge notice, faceted curves, glyph polylines)
    // is successful work — the parameter edit must not refuse it.
    expect(
      parameterBuildError(base, {
        ...base.derived,
        warnings: [
          'Feature "Pattern": instances overlap; volume double-counted.'
        ],
        featureWarnings: [
          {
            featureId: base.featureOrder[0]!,
            featureName: 'Pattern',
            message:
              'Feature "Pattern": instances overlap; volume double-counted.',
            kind: 'advisory'
          }
        ]
      })
    ).toBeNull();
    // The same refusal text migrating between same-named features is a new
    // failure, not a pre-existing one — the Set-based gate used to hide it.
    const message = 'Feature "Union": open result.';
    const refused = (featureId: string) => ({
      featureId: featureId as never,
      featureName: 'Union',
      message,
      kind: 'refusal' as const
    });
    const migratedBase: typeof base = {
      ...base,
      derived: {
        ...base.derived,
        warnings: [message],
        featureWarnings: [refused('feat_a')]
      }
    };
    expect(
      parameterBuildError(migratedBase, {
        ...migratedBase.derived,
        warnings: [message],
        featureWarnings: [refused('feat_b')]
      })
    ).toBe(message);
    // Occurrence counting: two identical base strings excuse two, not three.
    // (No featureWarnings channel here: the legacy string fallback must count
    // too — a Set would excuse any number.)
    const doubled: typeof base = {
      ...base,
      derived: {
        ...base.derived,
        warnings: [message, message],
        featureWarnings: undefined
      }
    };
    expect(
      parameterBuildError(doubled, {
        ...doubled.derived,
        warnings: [message, message, message]
      })
    ).toBe(message);
  });
});

describe('parameterUntouchedSince', () => {
  // A parameter edit is validated against the document it was typed into. When
  // that document moves meanwhile (an assistant patch landing, an undo), the
  // edit may be re-checked on the live document only if the parameter it sets
  // still reads as it did — otherwise "try again" is the honest answer.
  it('permits a re-check when the moved document left the parameter alone', () => {
    const base = holder();
    const live = setParameter(base, { name: 'hole_diameter', expression: '5' });
    expect(parameterUntouchedSince(base, live, 'opening_width')).toBe(true);
    // Creating a parameter the moved document still lacks is also safe.
    expect(parameterUntouchedSince(base, live, 'wall')).toBe(true);
  });
  it('refuses when the moved document changed, created or removed the parameter', () => {
    const base = holder();
    expect(
      parameterUntouchedSince(
        base,
        setParameter(base, { name: 'opening_width', expression: '52' }),
        'opening_width'
      )
    ).toBe(false);
    expect(
      parameterUntouchedSince(
        base,
        setParameter(base, { name: 'wall', expression: '3' }),
        'wall'
      )
    ).toBe(false);
    const withWall = setParameter(base, { name: 'wall', expression: '3' });
    expect(
      parameterUntouchedSince(
        withWall,
        deleteParameter(withWall, { name: 'wall' }),
        'wall'
      )
    ).toBe(false);
  });
});
