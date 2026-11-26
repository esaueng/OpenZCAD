import { describe, expect, it } from 'vitest';
import { commandContextFor } from './commandContext';
import {
  allToolsLead,
  allToolsSections,
  compactToolLabel,
  TRAY_TOOL_LIMIT,
  trayState,
  trayStep,
  trayTools
} from './compactTray';
import {
  TOOL_GROUPS,
  TOOL_META,
  type ToolAvailability,
  type ToolId
} from './tools';

const ALL_TOOLS = TOOL_GROUPS.flatMap((group) => group.tools);

const EMPTY: ToolAvailability = {
  sketchCount: 0,
  liveBodyCount: 0,
  exactGeometryReady: true,
  hasEdgeSelected: false
};
const ONE_BODY: ToolAvailability = { ...EMPTY, liveBodyCount: 1 };
const IDLE = commandContextFor({
  edgeCount: 0,
  faceSelected: false,
  bodyCount: 0,
  regionCount: 0
});

describe('the step chip', () => {
  it.each([
    ['Pick a profile', 'Profile'],
    ['Pick an axis: sketch line, edge or cylinder', 'Axis'],
    ['Drag the angle, or tap it to type', 'Angle'],
    ['Click the faces to open', 'Faces'],
    ['Click the body to rotate', 'Body'],
    ['Pick a plane or flat face', 'Plane'],
    ['Click a flat face', 'Flat face'],
    ['Pick the profile first, then the axis', 'Profile'],
    ['Click the sketch lines and arcs to repeat along', 'Sketch lines'],
    ['Tap the axis chips to type it', 'Axis chips'],
    ['Click where the hinge goes', 'Hinge'],
    ['2 edges · drag the radius', '2 edges'],
    ['Pick the next section', 'Next section'],
    ['', 'Pick']
  ])('says %j as %j', (hint, step) => {
    expect(trayStep(hint)).toBe(step);
  });

  it('keeps every chip within two words and one short line', () => {
    for (const hint of [
      'Pick the axis to coil around: a dashed line, an edge or a cylinder',
      'Drag the spacing · tap a copy to skip it',
      'Pick a ghost plane or flat face instead',
      'Extraordinarilylongwordthatneverends and more'
    ]) {
      const step = trayStep(hint);
      expect(step.split(' ').length, hint).toBeLessThanOrEqual(2);
      expect(step.length, hint).toBeLessThanOrEqual(18);
    }
  });

  it('says the state over the step while one stands', () => {
    expect(trayState({ locked: true })).toBe('Applying');
    expect(trayState({ queued: true, refused: true })).toBe('Applying');
    expect(trayState({ refused: true, building: true })).toBe(
      'Needs attention'
    );
    expect(trayState({ building: true })).toBe('Checking');
    expect(trayState({})).toBeNull();
  });
});

describe('the All tools grid', () => {
  it('names every tool in one word', () => {
    for (const tool of ALL_TOOLS) {
      const label = compactToolLabel(tool);
      expect(label.split(' '), tool).toHaveLength(1);
    }
  });

  it('lists all 45 tools in their five groups, the leading row first', () => {
    const sections = allToolsSections('', allToolsLead(['fillet'], []));
    expect(sections.map((section) => section.label)).toEqual([
      'Recent',
      ...TOOL_GROUPS.map((group) => group.label)
    ]);
    expect(sections[0]!.tools).toEqual(['fillet']);
    const grouped = sections.slice(1).flatMap((section) => section.tools);
    expect(grouped).toHaveLength(45);
    expect(new Set(grouped)).toEqual(new Set(Object.keys(TOOL_META)));
  });

  it('leads with the pins until a tool has been used, and with nothing after neither', () => {
    expect(allToolsLead([], ['box', 'hole'])).toEqual({
      label: 'Pinned',
      tools: ['box', 'hole']
    });
    expect(allToolsLead(['hole'], ['box'])?.label).toBe('Recent');
    expect(allToolsLead([], [])).toBeNull();
  });

  it('searches names, groups and hints, without the leading row', () => {
    const lead = allToolsLead(['box'], []);
    const pattern = allToolsSections('linear', lead);
    expect(pattern.map((section) => section.label)).toEqual(['Pattern']);
    expect(pattern[0]!.tools).toEqual(['linear-pattern']);
    const frame = allToolsSections('frame', lead);
    expect(frame.flatMap((section) => section.tools)).toContain('datum-csys');
    expect(allToolsSections('  ', lead)[0]!.label).toBe('Recent');
    expect(allToolsSections('zzz', lead)).toEqual([]);
  });
});

describe("the tray's suggested tools", () => {
  it('offers something to start an empty document with', () => {
    const tools = trayTools(IDLE, EMPTY);
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.length).toBeLessThanOrEqual(TRAY_TOOL_LIMIT);
    expect(tools).toContain('sketch');
    expect(tools).toContain('box');
  });

  it("follows the pick: an edge's finishing tools", () => {
    const edges = commandContextFor({
      edgeCount: 2,
      faceSelected: false,
      bodyCount: 1,
      regionCount: 0
    });
    expect(trayTools(edges, ONE_BODY)).toEqual(['fillet', 'chamfer']);
  });

  it('leads with what was used last, and offers no tool that cannot run', () => {
    const recent: ToolId[] = ['hole'];
    const tools = trayTools(IDLE, ONE_BODY, recent);
    expect(tools[0]).toBe('hole');
    expect(trayTools(IDLE, EMPTY)).not.toContain('fillet');
  });
});
