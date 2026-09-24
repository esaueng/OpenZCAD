import { describe, expect, it } from 'vitest';
import {
  commandContextFor,
  commandContextKind,
  remainingTools,
  type CommandContextKind,
  type CommandSelection
} from './commandContext';
import { TOOL_GROUPS } from './tools';

const NOTHING: CommandSelection = {
  edgeCount: 0,
  faceSelected: false,
  bodyCount: 0,
  regionCount: 0
};

const EVERY_KIND: Record<CommandContextKind, CommandSelection> = {
  idle: NOTHING,
  body: { ...NOTHING, bodyCount: 1 },
  bodies: { ...NOTHING, bodyCount: 2 },
  face: { ...NOTHING, faceSelected: true, bodyCount: 1 },
  edges: { ...NOTHING, edgeCount: 3, bodyCount: 1 },
  region: { ...NOTHING, regionCount: 1 }
};

describe('commandContextKind', () => {
  it('reads the most specific pick first', () => {
    for (const [kind, selection] of Object.entries(EVERY_KIND)) {
      expect(commandContextKind(selection)).toBe(kind);
    }
    // An edge pick wins over the body it belongs to and over a face.
    expect(
      commandContextKind({ ...NOTHING, edgeCount: 1, faceSelected: true })
    ).toBe('edges');
  });
});

describe('commandContextFor', () => {
  const allTools = TOOL_GROUPS.flatMap((group) => group.tools);

  it.each(Object.entries(EVERY_KIND))(
    '%s lists every tool exactly once across its rows and the grid',
    (_kind, selection) => {
      const context = commandContextFor(selection);
      const rows = context.groups.flatMap((group) => group.tools);
      expect(new Set(rows).size).toBe(rows.length);
      const everything = [...rows, ...remainingTools(context)];
      expect(everything).toHaveLength(allTools.length);
      expect(new Set(everything)).toEqual(new Set(allTools));
    }
  );

  it.each(Object.entries(EVERY_KIND))(
    '%s marks at most one primary tool, and only one of its own rows',
    (_kind, selection) => {
      const context = commandContextFor(selection);
      if (context.primary !== null) {
        expect(context.groups.flatMap((group) => group.tools)).toContain(
          context.primary
        );
      }
    }
  );

  it('offers the verbs each pick is for', () => {
    expect(commandContextFor(EVERY_KIND.idle).primary).toBe('sketch');
    expect(commandContextFor(EVERY_KIND.body).primary).toBe('transform');
    expect(commandContextFor(EVERY_KIND.bodies).primary).toBe('union');
    expect(commandContextFor(EVERY_KIND.edges).primary).toBe('fillet');
    expect(commandContextFor(EVERY_KIND.region).primary).toBe('extrude');
    // The face's own verbs are in the tool card, which marks its preferred
    // one; the command card does not name a second primary beside it.
    expect(commandContextFor(EVERY_KIND.face).primary).toBeNull();
  });
});
