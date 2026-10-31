import { describe, expect, it } from 'vitest';
import { commandContextFor, RAIL_GROUPS, RAIL_TOOLS } from './commandContext';
import {
  DEFAULT_PINNED_TOOLS,
  drawerGroups,
  MAX_RECENT_TOOLS,
  normalizeToolList,
  pinTool,
  railSections,
  recordRecentTool,
  shiftPinnedTool,
  suggestedTools,
  unpinTool
} from './toolRail';
import { TOOL_META, type ToolAvailability } from './tools';

const READY: ToolAvailability = {
  sketchCount: 0,
  liveBodyCount: 0,
  exactGeometryReady: true,
  hasEdgeSelected: false
};

const IDLE = commandContextFor({
  edgeCount: 0,
  faceSelected: false,
  bodyCount: 0,
  regionCount: 0
});

describe('tool rail pins', () => {
  it('starts as the original rail, in its original sections', () => {
    expect(DEFAULT_PINNED_TOOLS).toEqual(RAIL_TOOLS);
    expect(railSections(DEFAULT_PINNED_TOOLS)).toEqual(
      RAIL_GROUPS.map((group) => ({ label: group.label, tools: group.tools }))
    );
  });

  it('splits the pins into a new section wherever the kind changes', () => {
    expect(railSections(['fillet', 'box', 'cylinder', 'chamfer'])).toEqual([
      { label: 'Finish', tools: ['fillet'] },
      { label: 'Create', tools: ['box', 'cylinder'] },
      { label: 'Finish', tools: ['chamfer'] }
    ]);
    expect(railSections([])).toEqual([]);
  });

  it('pins at an index, moves a pinned tool, and unpins', () => {
    expect(pinTool(['box', 'fillet'], 'hole')).toEqual([
      'box',
      'fillet',
      'hole'
    ]);
    expect(pinTool(['box', 'fillet'], 'hole', 1)).toEqual([
      'box',
      'hole',
      'fillet'
    ]);
    // The index counts the list without the tool being moved.
    expect(pinTool(['box', 'fillet', 'hole'], 'box', 2)).toEqual([
      'fillet',
      'hole',
      'box'
    ]);
    expect(pinTool(['box'], 'hole', 99)).toEqual(['box', 'hole']);
    expect(pinTool(['box'], 'hole', -3)).toEqual(['hole', 'box']);
    expect(unpinTool(['box', 'hole'], 'box')).toEqual(['hole']);
  });

  it('shifts a pin one place, and leaves it at either end', () => {
    expect(shiftPinnedTool(['box', 'fillet', 'hole'], 'hole', -1)).toEqual([
      'box',
      'hole',
      'fillet'
    ]);
    expect(shiftPinnedTool(['box', 'fillet'], 'box', -1)).toEqual([
      'box',
      'fillet'
    ]);
    expect(shiftPinnedTool(['box', 'fillet'], 'fillet', 1)).toEqual([
      'box',
      'fillet'
    ]);
  });

  it('cleans a stored list: known tools, once each, in order', () => {
    expect(normalizeToolList(['box', 'nope', 'box', 3, 'hole'])).toEqual([
      'box',
      'hole'
    ]);
    expect(normalizeToolList([])).toEqual([]);
    expect(normalizeToolList('box')).toBeNull();
    expect(normalizeToolList({ 0: 'box' })).toBeNull();
    // An inherited name is not a tool.
    expect(normalizeToolList(['toString', 'constructor'])).toEqual([]);
  });

  it('keeps the recent tools newest first, each once, capped', () => {
    let recent = recordRecentTool([], 'box');
    recent = recordRecentTool(recent, 'fillet');
    recent = recordRecentTool(recent, 'box');
    expect(recent).toEqual(['box', 'fillet']);
    for (const tool of Object.keys(TOOL_META) as (keyof typeof TOOL_META)[]) {
      recent = recordRecentTool(recent, tool);
    }
    expect(recent).toHaveLength(MAX_RECENT_TOOLS);
  });
});

describe('tool rail suggestions', () => {
  it('offers somewhere to start in an empty document', () => {
    expect(suggestedTools(IDLE, READY, [])).toEqual([
      'sketch',
      'box',
      'cylinder'
    ]);
    // Pinned tools are already on the rail.
    expect(suggestedTools(IDLE, READY, DEFAULT_PINNED_TOOLS)).toEqual([
      'sphere'
    ]);
  });

  it('follows what the document is ready for with nothing picked', () => {
    const profile = { ...READY, sketchCount: 1, closedProfileSketchCount: 1 };
    expect(suggestedTools(IDLE, profile, DEFAULT_PINNED_TOOLS)).toEqual([
      'revolve'
    ]);
    const twoBodies = { ...READY, liveBodyCount: 2 };
    expect(suggestedTools(IDLE, twoBodies, DEFAULT_PINNED_TOOLS)).toEqual([
      'subtract',
      'chamfer',
      'shell'
    ]);
  });

  it('never suggests a tool that cannot run', () => {
    // An open chain is not a profile: nothing made from one is offered.
    const openChain = { ...READY, sketchCount: 1, closedProfileSketchCount: 0 };
    expect(suggestedTools(IDLE, openChain, [])).not.toContain('extrude');
    const waiting = { ...READY, liveBodyCount: 1, exactGeometryReady: false };
    expect(suggestedTools(IDLE, waiting, [])).toEqual([]);
    const locked = { ...READY, editDisabledReason: 'Read only' };
    expect(suggestedTools(IDLE, locked, [])).toEqual([]);
  });

  it('puts the recently used first, but only those that fit the pick', () => {
    const body = { ...READY, liveBodyCount: 2 };
    expect(
      suggestedTools(IDLE, body, DEFAULT_PINNED_TOOLS, ['gear', 'mirror'])
    ).toEqual(['gear', 'mirror', 'subtract']);
    const edges = commandContextFor({
      edgeCount: 2,
      faceSelected: false,
      bodyCount: 1,
      regionCount: 0
    });
    // Gear does not act on edges; chamfer does.
    expect(suggestedTools(edges, body, [], ['gear', 'chamfer'])).toEqual([
      'chamfer',
      'fillet'
    ]);
  });
});

describe('the tool drawer', () => {
  it('lists every tool under the palette headings when asked for all', () => {
    const groups = drawerGroups(IDLE, READY, 'all');
    expect(groups.flatMap((group) => group.tools)).toHaveLength(
      Object.keys(TOOL_META).length
    );
  });

  it('keeps what can run on the pick, and always the armed tool', () => {
    const fits = drawerGroups(IDLE, READY, 'fits').flatMap((g) => g.tools);
    expect(fits).toContain('box');
    expect(fits).not.toContain('fillet');
    const armed = drawerGroups(IDLE, READY, 'fits', '', 'fillet').flatMap(
      (g) => g.tools
    );
    expect(armed).toContain('fillet');
  });

  it('searches label, group and hint, past the filter', () => {
    expect(
      drawerGroups(IDLE, READY, 'fits', 'FILLET').flatMap((g) => g.tools)
    ).toEqual(['fillet']);
    expect(drawerGroups(IDLE, READY, 'fits', 'pattern')).toEqual([
      {
        label: 'Pattern',
        tools: ['linear-pattern', 'circular-pattern', 'grid-pattern']
      }
    ]);
    expect(drawerGroups(IDLE, READY, 'all', 'no such tool')).toEqual([]);
  });
});
