import { describe, expect, it } from 'vitest';
import {
  commandContextFor,
  commandContextKind,
  commandContextLabel,
  FOLD_GROUPS,
  RAIL_TOOLS,
  remainingTools,
  toolApplies,
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

describe('the rail composition', () => {
  const allTools = TOOL_GROUPS.flatMap((group) => group.tools);

  it('lists every tool exactly once across the rail and the fold', () => {
    const everything = [...RAIL_TOOLS, ...remainingTools()];
    expect(everything).toHaveLength(allTools.length);
    expect(new Set(everything)).toEqual(new Set(allTools));
  });

  it('is a fixed set of seven or eight verbs, whatever is picked', () => {
    expect(RAIL_TOOLS.length).toBeGreaterThanOrEqual(7);
    expect(RAIL_TOOLS.length).toBeLessThanOrEqual(8);
    // Composition takes no selection at all: nothing can re-sort it.
    expect(remainingTools()).toEqual(
      FOLD_GROUPS.flatMap((group) => group.tools)
    );
    // The fold keeps palette order.
    expect(remainingTools()).toEqual(
      allTools.filter((tool) => !RAIL_TOOLS.includes(tool))
    );
  });
});

describe('commandContextFor', () => {
  it.each(Object.entries(EVERY_KIND))(
    '%s marks at most one primary tool, one that acts on the pick and sits on the rail',
    (_kind, selection) => {
      const context = commandContextFor(selection);
      if (context.primary !== null) {
        expect(toolApplies(context, context.primary)).toBe(true);
        expect(RAIL_TOOLS).toContain(context.primary);
      }
    }
  );

  it('dims nothing while nothing is picked', () => {
    const context = commandContextFor(EVERY_KIND.idle);
    for (const tool of TOOL_GROUPS.flatMap((group) => group.tools)) {
      expect(toolApplies(context, tool)).toBe(true);
    }
  });

  it('offers the verbs each pick is for', () => {
    expect(commandContextFor(EVERY_KIND.idle).primary).toBe('sketch');
    expect(commandContextFor(EVERY_KIND.body).primary).toBe('transform');
    expect(commandContextFor(EVERY_KIND.bodies).primary).toBe('union');
    expect(commandContextFor(EVERY_KIND.edges).primary).toBe('fillet');
    expect(commandContextFor(EVERY_KIND.region).primary).toBe('extrude');
    // The face's own verbs are on the selection callout, which offers its
    // preferred one; the rail does not name a second primary beside it.
    expect(commandContextFor(EVERY_KIND.face).primary).toBeNull();
    const edges = commandContextFor(EVERY_KIND.edges);
    expect(toolApplies(edges, 'chamfer')).toBe(true);
    expect(toolApplies(edges, 'box')).toBe(false);
    const face = commandContextFor(EVERY_KIND.face);
    expect(toolApplies(face, 'hole')).toBe(true);
    expect(toolApplies(face, 'union')).toBe(false);
  });
});

describe('commandContextLabel', () => {
  it('names the pick the command bar filters to', () => {
    expect(commandContextLabel(EVERY_KIND.idle)).toBeNull();
    expect(commandContextLabel(EVERY_KIND.body)).toBe('1 body');
    expect(commandContextLabel(EVERY_KIND.bodies)).toBe('2 bodies');
    expect(commandContextLabel(EVERY_KIND.face)).toBe('1 face');
    expect(commandContextLabel(EVERY_KIND.edges)).toBe('3 edges');
    expect(commandContextLabel({ ...NOTHING, edgeCount: 1 })).toBe('1 edge');
    expect(commandContextLabel({ ...NOTHING, regionCount: 2 })).toBe(
      '2 regions'
    );
  });
});

describe('the body context', () => {
  it.each(['union', 'subtract', 'intersect'] as const)(
    'keeps %s available to seed operand one from a single picked body',
    (tool) => {
      const body = commandContextFor(EVERY_KIND.body);
      expect(toolApplies(body, tool)).toBe(true);
      expect(body.primary).toBe('transform');
    }
  );

  it('keeps every tool that starts from a picked body, Rotate about axis included', () => {
    const body = commandContextFor(EVERY_KIND.body);
    for (const tool of [
      'transform',
      'scale',
      'axis-rotate',
      'mirror',
      'linear-pattern'
    ] as const)
      expect(toolApplies(body, tool)).toBe(true);
    expect(toolApplies(body, 'box')).toBe(false);
  });
});
