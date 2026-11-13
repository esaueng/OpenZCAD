import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  act,
  createEvent,
  fireEvent,
  render,
  screen,
  within
} from '@testing-library/react';
import {
  Grid3x3,
  Layers,
  ListCollapse,
  List as ListIcon,
  Maximize2,
  Settings,
  Slice,
  Spline,
  SquareDashed,
  RotateCw
} from 'lucide-react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RAIL_GROUPS,
  RAIL_TOOLS,
  type CommandSelection
} from '../lib/commandContext';
import {
  DEFAULT_PINNED_TOOLS,
  type ToolDrawerFilter,
  type ToolDrawerView
} from '../lib/toolRail';
import { textLabelSegments } from '../lib/topologyLabels';
import {
  TOOL_GROUPS,
  TOOL_META,
  toolTitle,
  type ToolAvailability,
  type ToolId
} from '../lib/tools';
import { PANEL_ICONS } from './modelPanels/panelMeta';
import type { SelectionCalloutContent } from '../lib/selectionCallout';
import { CommandCard } from './CommandCard';
import { RELEASE_HOLD_MS } from './SelectionRail';

const AVAILABILITY: ToolAvailability = {
  sketchCount: 0,
  liveBodyCount: 1,
  exactGeometryReady: true,
  hasEdgeSelected: false
};

const NOTHING: CommandSelection = {
  edgeCount: 0,
  faceSelected: false,
  bodyCount: 0,
  regionCount: 0
};

const TOOL_COUNT = Object.keys(TOOL_META).length;

/** With one body and no sketch, nothing picked: what the rail suggests. */
const IDLE_SUGGESTIONS: ToolId[] = ['chamfer', 'shell'];

/** The rail with the drawer's state and the pins held the way App holds them. */
function Harness({
  selection,
  onLaunchTool,
  initialPins = DEFAULT_PINNED_TOOLS,
  initialFilter = 'all',
  initialView = 'advanced',
  onPins,
  ...extra
}: Partial<Parameters<typeof CommandCard>[0]> & {
  selection: CommandSelection;
  onLaunchTool(tool: string): void;
  initialPins?: readonly ToolId[];
  initialFilter?: ToolDrawerFilter;
  initialView?: ToolDrawerView;
  onPins?(pins: ToolId[]): void;
}) {
  const [moreOpen, setMoreOpen] = useState(false);
  const [pins, setPins] = useState<readonly ToolId[]>(initialPins);
  const [filter, setFilter] = useState<ToolDrawerFilter>(initialFilter);
  const [view, setView] = useState<ToolDrawerView>(initialView);
  return (
    <CommandCard
      summary={null}
      activeTool={null}
      availability={AVAILABILITY}
      {...extra}
      selection={selection}
      onLaunchTool={onLaunchTool}
      moreOpen={moreOpen}
      onToggleMore={() => setMoreOpen((open) => !open)}
      pinnedTools={pins}
      onPinnedToolsChange={(next) => {
        onPins?.(next);
        setPins(next);
      }}
      drawerFilter={filter}
      onDrawerFilterChange={setFilter}
      drawerView={view}
      onDrawerViewChange={setView}
    />
  );
}

function renderCard(
  selection: CommandSelection = NOTHING,
  extra: Partial<Parameters<typeof Harness>[0]> = {}
) {
  const onLaunchTool = vi.fn();
  const view = render(
    <Harness selection={selection} onLaunchTool={onLaunchTool} {...extra} />
  );
  return { ...view, onLaunchTool };
}

const TOOL_BY_LABEL = new Map(
  Object.entries(TOOL_META).map(([tool, meta]) => [meta.label, tool])
);

/** The tool ids the buttons stand for, in document order. */
const toolsOf = (buttons: NodeListOf<Element>) =>
  Array.from(buttons).map((button) =>
    TOOL_BY_LABEL.get(
      (button.getAttribute('aria-label') ?? '')
        .replace(/^On rail: /, '')
        .replace(/ (\(.\) )?— .*$/, '')
    )
  );

const railTools = (container: HTMLElement) =>
  toolsOf(container.querySelectorAll('button[data-pinned-tool]'));

const suggestedRail = (container: HTMLElement) =>
  toolsOf(container.querySelectorAll('button.command-rail.is-suggested'));

const foldTools = (container: HTMLElement) =>
  toolsOf(container.querySelectorAll('.command-tile'));

const openDrawer = () =>
  fireEvent.click(screen.getByRole('button', { name: /^More tools/ }));

/**
 * Greyed, as the rail greys: by `aria-disabled`, never `disabled`, so the
 * arrow keys still reach the button and it keeps the keyboard's focus.
 */
const greyed = (element: Element) =>
  element.getAttribute('aria-disabled') === 'true';

/** A DataTransfer stand-in: happy-dom's drag events carry none. */
function dataTransfer() {
  const data = new Map<string, string>();
  return {
    dropEffect: 'none',
    effectAllowed: 'all',
    setData: (type: string, value: string) => void data.set(type, value),
    getData: (type: string) => data.get(type) ?? '',
    types: [] as string[]
  };
}

/**
 * A dragover or drop at a height on the page: happy-dom's drag events drop
 * the pointer coordinates their init carries.
 */
function dragAt(
  type: 'dragOver' | 'drop',
  target: Element,
  transfer: ReturnType<typeof dataTransfer>,
  clientY: number
) {
  const event = createEvent[type](target, { dataTransfer: transfer });
  Object.defineProperty(event, 'clientY', { value: clientY });
  fireEvent(target, event);
}

/** Lays the pinned buttons out 32px apart, from the top, by pin order. */
function layOutPins(container: HTMLElement) {
  container
    .querySelectorAll<HTMLElement>('button[data-pinned-tool]')
    .forEach((button, index) => {
      button.getBoundingClientRect = () =>
        ({ top: index * 32, height: 30, bottom: index * 32 + 30 }) as DOMRect;
    });
}

describe('CommandCard', () => {
  it('keeps the palette’s composed accessible names without native titles', () => {
    renderCard();
    const box = screen.getByRole('button', {
      name: toolTitle('box', AVAILABILITY)
    });
    expect(box).not.toHaveAttribute('title');
    expect(box).toHaveClass('command-rail');
    // Extrude is pinned too, greyed with the reason it cannot run.
    const extrude = screen.getByRole('button', {
      name: 'Extrude (E) — Create a sketch first'
    });
    expect(extrude).toHaveAttribute('aria-disabled', 'true');
    expect(extrude).toHaveClass('command-rail');
    // Revolve waits in the drawer, still by name.
    expect(
      screen.queryByRole('button', {
        name: 'Revolve (R) — Create a sketch first'
      })
    ).toBeNull();
    openDrawer();
    const revolve = screen.getByRole('button', {
      name: 'Revolve (R) — Create a sketch first'
    });
    expect(revolve).toHaveAttribute('aria-disabled', 'true');
    expect(revolve).toHaveClass('command-tile');
    expect(revolve).toHaveTextContent('Revolve');
    // Its key reads on the row, not only in the tooltip.
    expect(revolve.querySelector('kbd')).toHaveTextContent('R');
  });

  it('pins the original verbs by default, Sketch lit, with suggestions under them', () => {
    const { container } = renderCard();
    // Nothing names the pick here: the selection callout does that.
    expect(container.querySelector('.command-card-head')).toBeNull();
    expect(railTools(container)).toEqual(RAIL_TOOLS);
    for (const group of RAIL_GROUPS) {
      const section = screen.getByRole('group', { name: group.label });
      expect(toolsOf(section.querySelectorAll('button'))).toEqual(group.tools);
    }
    const sketch = within(
      screen.getByRole('group', { name: 'Sketch' })
    ).getByRole('button', { name: /^Sketch \(S\)/ });
    expect(sketch).toHaveClass('is-primary');
    // Icon only: the name and key ride the tooltip.
    expect(sketch).toHaveTextContent('');
    expect(sketch.querySelector('svg')).not.toBeNull();
    // Nothing is picked, so nothing is dimmed.
    expect(container.querySelectorAll('.is-dim')).toHaveLength(0);
    // One body is up: the rail suggests finishing it, past the pins.
    expect(suggestedRail(container)).toEqual(IDLE_SUGGESTIONS);
    expect(
      within(screen.getByRole('group', { name: 'Suggested' })).getAllByRole(
        'button'
      )
    ).toHaveLength(IDLE_SUGGESTIONS.length);
  });

  it('drops the primary hint while a tool is armed, so one button is lit', () => {
    const { container } = renderCard(NOTHING, { activeTool: 'box' });
    const box = screen.getByRole('button', { name: /^Box \(B\)/ });
    expect(box).toHaveClass('active');
    expect(box).not.toHaveClass('is-primary');
    expect(
      screen.getByRole('button', { name: /^Sketch \(S\)/ })
    ).not.toHaveClass('is-primary');
    expect(container.querySelectorAll('.is-primary')).toHaveLength(0);
    expect(
      container.querySelectorAll('button.command-rail.active')
    ).toHaveLength(1);
  });

  it('draws the primary hint without any selected treatment', () => {
    // The hint once carried the accent fill, the same weight as an armed
    // tool's outline, so two rail buttons read as active; later an accent
    // icon and edge bar still read as selected while nothing was armed.
    const css = readFileSync(
      resolve(__dirname, '../styles/components/quiet-stage.css'),
      'utf8'
    );
    const rules = Array.from(
      css.matchAll(/([^{}]+)\{([^{}]*)\}/g),
      (match) => ({ selector: match[1]!.trim(), body: match[2]! })
    ).filter((rule) => /\.command-rail\.is-primary\b/.test(rule.selector));
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(rule.selector).not.toMatch(/::(before|after)/);
      expect(rule.body).not.toMatch(
        /background|border|outline|box-shadow|accent|selected/
      );
    }
  });

  it.each([
    ['body', { ...NOTHING, bodyCount: 1 }, ['scale', 'subtract', 'intersect']],
    [
      'bodies',
      { ...NOTHING, bodyCount: 2 },
      ['subtract', 'intersect', 'mirror']
    ],
    [
      'face',
      { ...NOTHING, faceSelected: true, bodyCount: 1 },
      ['datum-plane', 'draft', 'thicken']
    ],
    ['edges', { ...NOTHING, edgeCount: 3, bodyCount: 1 }, ['chamfer']],
    ['region', { ...NOTHING, regionCount: 1 }, []]
  ] as const)(
    'keeps every pin in place when a %s is picked, and suggests its tools',
    (kind, selection, suggested) => {
      const { container } = renderCard(selection, {
        availability: { ...AVAILABILITY, liveBodyCount: 2 }
      });
      expect(
        screen.getByRole('toolbar', { name: 'Feature tools' })
      ).toHaveAttribute('data-context', kind);
      expect(railTools(container)).toEqual(RAIL_TOOLS);
      expect(suggestedRail(container)).toEqual(suggested);
    }
  );

  it('dims the pins that do not act on the pick, without removing them', () => {
    const { container } = renderCard(
      { ...NOTHING, edgeCount: 3, bodyCount: 1 },
      {
        summary: { label: textLabelSegments('3 edges'), detail: '306 mm' },
        onClear: vi.fn()
      }
    );
    const fillet = screen.getByRole('button', { name: /^Fillet/ });
    expect(fillet).toHaveClass('is-primary');
    expect(fillet).not.toHaveClass('is-dim');
    const box = screen.getByRole('button', { name: /^Box \(B\)/ });
    expect(box).toHaveClass('is-dim');
    expect(box).toHaveAttribute('data-applies', 'false');
    // Dimmed is not disabled: the tool still launches and picks its input.
    expect(box).toBeEnabled();
    // Chamfer acts on edges and is not pinned, so the rail suggests it.
    const chamfer = screen.getByRole('button', { name: /^Chamfer/ });
    expect(chamfer).toHaveClass('command-rail', 'is-suggested');
    expect(chamfer).not.toHaveClass('is-dim');
    openDrawer();
    // Every other row that does not act on the edges is dimmed.
    expect(container.querySelectorAll('.command-tile.is-dim').length).toBe(
      TOOL_COUNT - 2
    );
  });

  it('keeps the drawer closed by default and counts what the rail does not carry', () => {
    const { container } = renderCard();
    const fold = screen.getByRole('group', { name: 'All tools' });
    const toggle = within(fold).getByRole('button', { name: /^More tools/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(container.querySelector('.command-flyout')).toBeNull();
    const rest = TOOL_COUNT - RAIL_TOOLS.length - IDLE_SUGGESTIONS.length;
    expect(toggle).toHaveAccessibleName(`More tools (${rest})`);
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    // One column of every tool under the palette's own headings.
    expect(container.querySelectorAll('.command-tile')).toHaveLength(
      TOOL_COUNT
    );
    expect(
      Array.from(container.querySelectorAll('.command-flyout-heading')).map(
        (node) => node.textContent
      )
    ).toEqual(TOOL_GROUPS.map((group) => group.label));
    fireEvent.click(toggle);
    expect(container.querySelector('.command-flyout')).toBeNull();
  });

  it('gives the rail to a pick: Deselect all and its verbs, every tool in the fold', () => {
    const onVerb = vi.fn();
    const onClear = vi.fn();
    const { container } = renderCard(
      { ...NOTHING, faceSelected: true, bodyCount: 1 },
      {
        pickSummary: '1 face',
        pick: {
          label: textLabelSegments('Bracket · Top face'),
          detail: '2503.45 mm²',
          verbs: [
            {
              id: 'action:offset-face',
              label: 'Offset',
              title: 'Offset the face',
              disabled: false,
              pressed: true
            },
            {
              id: 'tool:shell',
              label: 'Shell',
              title: 'Shell',
              disabled: false,
              pressed: false
            }
          ],
          anchor: 'selection',
          onVerb,
          onClear
        }
      }
    );
    // The pins give way: none of the rail's own groups is drawn.
    for (const group of RAIL_GROUPS) {
      expect(screen.queryByRole('group', { name: group.label })).toBeNull();
    }
    const rail = screen.getByRole('group', { name: 'Selection' });
    expect(
      within(rail)
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label'))
    ).toEqual(['Deselect all', 'Selection: Offset', 'Selection: Shell']);
    fireEvent.click(within(rail).getByRole('button', { name: 'Deselect all' }));
    expect(onClear).toHaveBeenCalledOnce();
    fireEvent.click(
      within(rail).getByRole('button', { name: 'Selection: Shell' })
    );
    expect(onVerb).toHaveBeenCalledWith('tool:shell');
    // Every tool, the rail's fixed ones included, stays a press away.
    const toggle = screen.getByRole('button', { name: /^More tools/ });
    expect(toggle).toHaveAccessibleName(
      `More tools (${Object.keys(TOOL_META).length})`
    );
    fireEvent.click(toggle);
    expect(foldTools(container)).toEqual(
      expect.arrayContaining([...RAIL_TOOLS])
    );
    // Nothing is on the rail, so no row says it is.
    expect(container.querySelector('[aria-label^="On rail:"]')).toBeNull();
    expect(container.querySelectorAll('.command-tile')).toHaveLength(
      Object.keys(TOOL_META).length
    );
  });

  const offsetPick = (
    phase: NonNullable<SelectionCalloutContent['operation']>['phase']
  ): SelectionCalloutContent => ({
    label: textLabelSegments('Bracket · Top face'),
    verbs: [
      {
        id: 'action:offset-face',
        label: 'Offset',
        title: 'Offset the face',
        disabled: false,
        pressed: true
      },
      {
        id: 'tool:hole',
        label: 'Hole',
        title: 'Hole',
        disabled: false,
        pressed: false
      }
    ],
    anchor: 'selection',
    onVerb: vi.fn(),
    onClear: vi.fn(),
    operation: {
      title: 'Offset Face',
      phase,
      onEditCulprit: vi.fn(),
      onViewDetails: vi.fn(),
      onKeepLastValid: vi.fn(),
      onSelectAllEdges: vi.fn()
    }
  });
  const railButtons = () =>
    screen
      .getAllByRole('button')
      .map((b) => [
        b.getAttribute('aria-label'),
        greyed(b)
      ]);

  it('holds the rail in place while a verb is dragged', () => {
    const face = { ...NOTHING, faceSelected: true, bodyCount: 1 };
    const { rerender, onLaunchTool } = renderCard(face, {
      pickSummary: '1 face',
      pick: offsetPick('armed')
    });
    const more = `More tools (${TOOL_COUNT})`;
    expect(railButtons()).toEqual([
      ['Deselect all', false],
      ['Selection: Offset', false],
      ['Selection: Hole', false],
      [more, false]
    ]);
    // Nothing leaves the rail and nothing moves: only the verb being made
    // still acts, More tools included.
    rerender(
      <Harness
        selection={face}
        onLaunchTool={onLaunchTool}
        pickSummary="1 face"
        pick={offsetPick('dragging')}
      />
    );
    expect(railButtons()).toEqual([
      ['Deselect all', true],
      ['Selection: Offset', false],
      ['Selection: Hole', true],
      [more, true]
    ]);
  });

  it('never flashes the pinned tools when the pick drops out on release', () => {
    vi.useFakeTimers();
    try {
      const face = { ...NOTHING, faceSelected: true, bodyCount: 1 };
      const { rerender, container, onLaunchTool } = renderCard(face, {
        pickSummary: '1 face',
        pick: offsetPick('dragging')
      });
      const view = (pick: SelectionCalloutContent | null) => (
        <Harness
          selection={face}
          onLaunchTool={onLaunchTool}
          pickSummary="1 face"
          pick={pick}
        />
      );
      // The release can lose the pick for a frame or two before the check's
      // pick arrives: the rail stays the pick's, held, throughout.
      rerender(view(null));
      expect(railTools(container)).toEqual([]);
      expect(
        greyed(screen.getByRole('button', { name: 'Selection: Offset' }))
      ).toBe(true);
      rerender(view(offsetPick('armed')));
      expect(railTools(container)).toEqual([]);
      expect(
        greyed(screen.getByRole('button', { name: 'Selection: Hole' }))
      ).toBe(false);
      // A pick really gone gives the rail back to the pins.
      rerender(view(null));
      expect(railTools(container)).toEqual(DEFAULT_PINNED_TOOLS);
      // And so does a held pick that never comes back.
      rerender(view(offsetPick('dragging')));
      rerender(view(null));
      act(() => {
        vi.advanceTimersByTime(RELEASE_HOLD_MS);
      });
      expect(railTools(container)).toEqual(DEFAULT_PINNED_TOOLS);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives the rail back at once when Undo clears the pick mid-drag', () => {
    vi.useFakeTimers();
    try {
      const face = { ...NOTHING, faceSelected: true, bodyCount: 1 };
      const { rerender, container, onLaunchTool } = renderCard(face, {
        pickSummary: '1 face',
        pick: offsetPick('dragging'),
        pickRevision: 'project:0'
      });
      // Undo rewinds the document and clears the pick in one batch: a
      // deselection, not a release settling. The pins are back in that
      // frame, never a greyed-out rail for the deleted body.
      rerender(
        <Harness
          selection={NOTHING}
          onLaunchTool={onLaunchTool}
          pickSummary=""
          pick={null}
          pickRevision="project:1"
        />
      );
      expect(railTools(container)).toEqual(DEFAULT_PINNED_TOOLS);
      expect(
        screen.queryByRole('region', { name: 'Offset Face operation' })
      ).toBeNull();
      expect(
        greyed(screen.getByRole('button', { name: /^More tools/ }))
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes the drawer while a drag holds the rail and reopens it after', () => {
    // A record of every layout observer, so one left on a drawer that has
    // gone shows up. happy-dom has no ResizeObserver of its own.
    const observers: { targets: Set<Element>; live: boolean }[] = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        private entry = { targets: new Set<Element>(), live: true };
        constructor() {
          observers.push(this.entry);
        }
        observe(target: Element) {
          this.entry.targets.add(target);
        }
        unobserve(target: Element) {
          this.entry.targets.delete(target);
        }
        disconnect() {
          this.entry.live = false;
          this.entry.targets.clear();
        }
      }
    );
    try {
      const face = { ...NOTHING, faceSelected: true, bodyCount: 1 };
      const { rerender, container, onLaunchTool } = renderCard(face, {
        pickSummary: '1 face',
        pick: offsetPick('armed'),
        initialView: 'simple'
      });
      const view = (phase: 'armed' | 'dragging') => (
        <Harness
          selection={face}
          onLaunchTool={onLaunchTool}
          pickSummary="1 face"
          pick={offsetPick(phase)}
          initialView="simple"
        />
      );
      const toggle = () => screen.getByRole('button', { name: /^More tools/ });
      const observed = () =>
        observers.filter((entry) => entry.live).flatMap((entry) => [
          ...entry.targets
        ]);
      const drawerTabStops = () =>
        Array.from(
          container.querySelectorAll<HTMLElement>(
            '.command-flyout button:not([disabled]), .command-flyout input'
          )
        ).filter((element) => element.tabIndex >= 0);
      openDrawer();
      expect(toggle()).toHaveAttribute('aria-expanded', 'true');
      const firstDrawer = container.querySelector('.command-flyout')!;
      expect(firstDrawer).not.toBeNull();
      expect(drawerTabStops().length).toBeGreaterThan(0);
      expect(observed()).toContain(firstDrawer);

      // The handle is grabbed: the drawer goes, and nothing says it is
      // open. The toggle stays in place, greyed, and refuses its press.
      rerender(view('dragging'));
      expect(container.querySelector('.command-flyout')).toBeNull();
      expect(toggle()).toHaveAttribute('aria-expanded', 'false');
      expect(greyed(toggle())).toBe(true);
      fireEvent.click(toggle());
      expect(container.querySelector('.command-flyout')).toBeNull();
      expect(toggle()).not.toHaveClass('active');
      expect(container.querySelector('.command-more')).not.toHaveClass('open');
      expect(drawerTabStops()).toEqual([]);
      // No observer is left on the drawer that went.
      expect(observed().every((target) => target.isConnected)).toBe(true);
      expect(observed()).not.toContain(firstDrawer);

      // Released and answered: the drawer the user left open is back, and
      // the layout hooks measure the new one, not the detached one.
      rerender(view('armed'));
      const secondDrawer = container.querySelector('.command-flyout')!;
      expect(secondDrawer).not.toBeNull();
      expect(secondDrawer).not.toBe(firstDrawer);
      expect(toggle()).toHaveAttribute('aria-expanded', 'true');
      expect(greyed(toggle())).toBe(false);
      expect(drawerTabStops().length).toBeGreaterThan(0);
      expect(observed()).toContain(secondDrawer);
      expect(observed()).toContain(
        container.querySelector('.command-flyout-list')
      );
      expect(observed().every((target) => target.isConnected)).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('launches a tool from the rail or from the drawer', () => {
    const { onLaunchTool } = renderCard({ ...NOTHING, bodyCount: 1 });
    fireEvent.click(screen.getByRole('button', { name: /^Move \(M\)/ }));
    openDrawer();
    fireEvent.click(screen.getByRole('button', { name: /^Sphere/ }));
    fireEvent.click(screen.getByRole('button', { name: /^On rail: Box/ }));
    expect(onLaunchTool).toHaveBeenNthCalledWith(1, 'transform');
    expect(onLaunchTool).toHaveBeenNthCalledWith(2, 'sphere');
    expect(onLaunchTool).toHaveBeenNthCalledWith(3, 'box');
  });

  it.each([
    ['idle', NOTHING],
    ['body', { ...NOTHING, bodyCount: 1 }],
    ['face', { ...NOTHING, faceSelected: true, bodyCount: 1 }],
    ['edges', { ...NOTHING, edgeCount: 2, bodyCount: 1 }]
  ] as const)(
    'in the %s context every tool has one button of its own name',
    (_kind, selection) => {
      renderCard(selection);
      openDrawer();
      for (const [tool, meta] of Object.entries(TOOL_META)) {
        // Every RegExp metacharacter, backslash included, so a label is
        // matched literally whatever it holds.
        const escaped = meta.label.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
        expect(
          screen.getAllByRole('button', {
            name: new RegExp(`^${escaped}( \\(.\\))? — `)
          }),
          tool
        ).toHaveLength(1);
      }
    }
  );

  it('gives every tool its own icon', () => {
    // The rail shows icons alone, and two tools with one glyph read as the
    // same tool: compare the rendered markup, not the component names.
    const { container } = renderCard();
    openDrawer();
    const glyphs = Array.from(
      container.querySelectorAll('.command-tile > svg')
    ).map((svg) => svg.innerHTML);
    expect(glyphs).toHaveLength(TOOL_COUNT);
    expect(new Set(glyphs).size).toBe(glyphs.length);
  });

  it('borrows no glyph another surface uses for something else', () => {
    // The grid pattern once wore the viewer's grid toggle, Split its section
    // view, Loft the Objects panel's layers, Gear teeth the app's Settings,
    // Sweep the sketch's spline and Revolve its rotate: each read as the
    // other command. The drawer's own switch has glyphs of its own too.
    const { container } = renderCard();
    openDrawer();
    const tools = new Set(
      Array.from(container.querySelectorAll('.command-tile > svg')).map(
        (svg) => svg.innerHTML
      )
    );
    const others = [
      Grid3x3,
      Slice,
      Maximize2,
      Settings,
      Spline,
      SquareDashed,
      RotateCw,
      Layers,
      ...Object.values(PANEL_ICONS)
    ];
    const { container: elsewhere } = render(
      <div>
        {others.map((Icon, index) => (
          <Icon key={index} size={16} />
        ))}
        <ListIcon size={16} />
        <ListCollapse size={16} />
      </div>
    );
    for (const svg of Array.from(elsewhere.querySelectorAll('svg'))) {
      expect(tools.has(svg.innerHTML), svg.getAttribute('class') ?? '').toBe(
        false
      );
    }
  });

  it('lists only what fits now, and shows the rest on request', () => {
    const { container } = renderCard(NOTHING, { initialFilter: 'fits' });
    openDrawer();
    const fits = screen.getByRole('button', { name: 'Ready now' });
    expect(fits).toHaveAttribute('aria-pressed', 'true');
    // No sketch yet: nothing made from one is listed, nor any boolean.
    expect(screen.queryByRole('button', { name: /^Revolve/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Subtract/ })).toBeNull();
    expect(screen.getByRole('button', { name: /^Sphere/ })).toBeEnabled();
    expect(
      container.querySelector('.command-tile[aria-disabled="true"]')
    ).toBeNull();
    const hidden =
      TOOL_COUNT - container.querySelectorAll('.command-tile').length;
    expect(hidden).toBeGreaterThan(0);
    const all = screen.getByRole('button', { name: `All ${TOOL_COUNT}` });
    fireEvent.click(all);
    expect(all).toHaveAttribute('aria-pressed', 'true');
    expect(container.querySelectorAll('.command-tile')).toHaveLength(
      TOOL_COUNT
    );
  });

  it('names the pick on the fits switch and keeps to its tools', () => {
    const { container } = renderCard(
      { ...NOTHING, edgeCount: 2, bodyCount: 1 },
      { initialFilter: 'fits' }
    );
    openDrawer();
    expect(screen.getByRole('button', { name: 'For 2 edges' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(foldTools(container)).toEqual(['fillet', 'chamfer']);
  });

  it('finds a tool by name or by what it does, whatever the filter', () => {
    const { container } = renderCard(NOTHING, { initialFilter: 'fits' });
    openDrawer();
    const search = screen.getByRole('searchbox', { name: 'Find a tool' });
    fireEvent.change(search, { target: { value: 'revol' } });
    expect(foldTools(container)).toEqual(['revolve']);
    fireEvent.change(search, { target: { value: 'repeat' } });
    expect(foldTools(container)).toEqual([
      'linear-pattern',
      'circular-pattern',
      'grid-pattern'
    ]);
    fireEvent.change(search, { target: { value: 'zzz' } });
    expect(container.querySelector('.command-flyout-empty')).toHaveTextContent(
      'No tool matches'
    );
  });

  it('focuses catalog search for keyboard entry and restores the toggle on Escape', () => {
    renderCard(NOTHING, { initialView: 'advanced' });
    const toggle = screen.getByRole('button', { name: /^More tools/ });
    fireEvent.click(toggle, { detail: 0 });
    const search = screen.getByRole('searchbox', { name: 'Find a tool' });
    expect(search).toHaveFocus();
    fireEvent.change(search, { target: { value: 'Loft' } });
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(search).toHaveValue('');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    expect(toggle).toHaveFocus();
  });

  it('pins and unpins from the drawer, and resets to the original rail', () => {
    const onPins = vi.fn();
    const { container } = renderCard(NOTHING, { onPins });
    openDrawer();
    fireEvent.click(
      screen.getByRole('button', { name: 'Pin Sphere to the rail' })
    );
    expect(railTools(container)).toEqual([...RAIL_TOOLS, 'sphere']);
    // Pinned, its row says so and its button gives the rail the name.
    expect(
      screen.getByRole('button', { name: 'Unpin Sphere from the rail' })
    ).toHaveAttribute('aria-pressed', 'true');
    expect(
      screen.getByRole('button', { name: /^On rail: Sphere/ })
    ).toHaveClass('command-tile');
    fireEvent.click(
      screen.getByRole('button', { name: 'Unpin Box from the rail' })
    );
    expect(railTools(container)).not.toContain('box');
    fireEvent.click(screen.getByRole('button', { name: 'Reset pinned tools' }));
    expect(railTools(container)).toEqual(RAIL_TOOLS);
    expect(onPins).toHaveBeenLastCalledWith([...RAIL_TOOLS]);
    expect(
      screen.getByRole('button', { name: 'Reset pinned tools' })
    ).toBeDisabled();
  });

  it('pins a tool dragged from the drawer where it is dropped on the rail', () => {
    const { container } = renderCard();
    openDrawer();
    layOutPins(container);
    const transfer = dataTransfer();
    fireEvent.dragStart(screen.getByRole('button', { name: /^Sphere/ }), {
      dataTransfer: transfer
    });
    // It drags as the small icon it will be on the rail, not as the row:
    // a rail-sized copy of its glyph, drawn for the browser's picture.
    const sphereGlyph = screen
      .getByRole('button', { name: /^Sphere/ })
      .querySelector('svg')!.innerHTML;
    const image = document.body.querySelector('.command-drag-image');
    expect(image?.querySelector('svg')?.innerHTML).toBe(sphereGlyph);
    const pins = container.querySelector('.command-rail-pins')!;
    expect(pins).toHaveClass('is-drop-target');
    // Below the second pin's middle (47px), above the third's (79px): the
    // landing slot, Sphere's icon at the rail's size, stands before Box.
    dragAt('dragOver', pins, transfer, 60);
    const slot = container.querySelector('.command-rail-slot')!;
    expect(slot.nextElementSibling).toBe(
      screen.getByRole('button', { name: /^Box \(B\)/ })
    );
    expect(slot.querySelector('svg')?.innerHTML).toBe(sphereGlyph);
    dragAt('drop', pins, transfer, 60);
    expect(railTools(container)).toEqual([
      'sketch',
      'extrude',
      'sphere',
      ...RAIL_TOOLS.slice(2)
    ]);
    expect(container.querySelector('.command-rail-slot')).toBeNull();
  });

  it('reorders pins by dragging, and unpins one dropped on the drawer', () => {
    const { container } = renderCard();
    openDrawer();
    layOutPins(container);
    const transfer = dataTransfer();
    const union = screen.getByRole('button', { name: /^Union/ });
    fireEvent.dragStart(union, { dataTransfer: transfer });
    const pins = container.querySelector('.command-rail-pins')!;
    dragAt('drop', pins, transfer, 0);
    expect(railTools(container)[0]).toBe('union');

    layOutPins(container);
    fireEvent.dragStart(screen.getByRole('button', { name: /^Hole/ }), {
      dataTransfer: transfer
    });
    const drawer = container.querySelector('.command-flyout')!;
    expect(drawer).toHaveClass('is-unpin-target');
    expect(drawer).toHaveTextContent('Drop to unpin');
    fireEvent.drop(drawer, { dataTransfer: transfer });
    expect(railTools(container)).not.toContain('hole');
    // Unpinned, Hole has nothing to fit with no pick: it is a suggestion now.
    expect(suggestedRail(container)).toContain('hole');
  });

  it('places a dragged tool between columns in a compact rail', () => {
    const { container } = renderCard();
    openDrawer();
    container
      .querySelectorAll<HTMLElement>('[data-pinned-tool]')
      .forEach((button, index) => {
        vi.spyOn(button, 'getBoundingClientRect').mockReturnValue(
          new DOMRect((index % 2) * 40, Math.floor(index / 2) * 32, 30, 30)
        );
      });
    const transfer = dataTransfer();
    fireEvent.dragStart(screen.getByRole('button', { name: /^Sphere/ }), {
      dataTransfer: transfer
    });
    const pins = container.querySelector('.command-rail-pins')!;
    const drop = createEvent.drop(pins, { dataTransfer: transfer });
    Object.defineProperties(drop, {
      clientX: { value: 39 },
      clientY: { value: 16 }
    });
    fireEvent(pins, drop);
    expect(railTools(container).slice(0, 3)).toEqual([
      'sketch',
      'sphere',
      'extrude'
    ]);
  });

  it('moves a focused pin with Alt+arrow keys and keeps it focused', () => {
    const { container } = renderCard();
    const box = screen.getByRole('button', { name: /^Box \(B\)/ });
    box.focus();
    fireEvent.keyDown(box, { key: 'ArrowUp', altKey: true });
    expect(railTools(container).slice(0, 3)).toEqual([
      'sketch',
      'box',
      'extrude'
    ]);
    expect(screen.getByRole('button', { name: /^Box \(B\)/ })).toHaveFocus();
    // Without Alt the arrows are the page's.
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(railTools(container)[1]).toBe('box');
  });

  it('opens simple: what fits and is not on the rail, by name alone', () => {
    const { container } = renderCard(NOTHING, {
      initialView: 'simple',
      initialFilter: 'all'
    });
    openDrawer();
    const drawer = container.querySelector('.command-flyout')!;
    expect(drawer).toHaveClass('is-simple');
    // No search, switch, keys or pins: those are the advanced view's.
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(screen.queryByRole('group', { name: 'Show tools' })).toBeNull();
    expect(drawer.querySelector('kbd, .command-tile-pin')).toBeNull();
    const listed = foldTools(container);
    // Every row can run now and is one the rail does not carry.
    for (const tool of [...RAIL_TOOLS, ...IDLE_SUGGESTIONS]) {
      expect(listed).not.toContain(tool);
    }
    expect(listed).toContain('sphere');
    expect(listed).not.toContain('revolve');
    expect(
      container.querySelector('.command-tile[aria-disabled="true"]')
    ).toBeNull();
    // The way on names how many the short list leaves out.
    const expand = screen.getByRole('button', { name: /^All tools & pins/ });
    expect(expand).toHaveTextContent(`+${TOOL_COUNT - listed.length}`);
    const foot = container.querySelector('.command-flyout-foot')!;
    expect(foot.firstElementChild).toBe(expand);
    fireEvent.click(expand);
    expect(drawer).toHaveClass('is-advanced');
    expect(
      screen.getByRole('searchbox', { name: 'Find a tool' })
    ).toBeVisible();
    expect(container.querySelectorAll('.command-tile')).toHaveLength(
      TOOL_COUNT
    );
    // The way back stands where the way in was: the foot's first control.
    const back = screen.getByRole('button', { name: 'Simple view' });
    expect(foot.firstElementChild).toBe(back);
    fireEvent.click(back);
    expect(drawer).toHaveClass('is-simple');
  });

  it('says so when everything that fits is already on the rail', () => {
    renderCard(
      { ...NOTHING, edgeCount: 2, bodyCount: 1 },
      { initialView: 'simple' }
    );
    openDrawer();
    expect(screen.queryByRole('button', { name: /^Chamfer.*—/ })).toHaveClass(
      'command-rail'
    );
    expect(
      screen.getByText('Everything that fits is on the rail')
    ).toBeVisible();
  });

  it('leaves the pick’s own tools out of the simple list', () => {
    const verb = (id: `tool:${ToolId}` | 'action:sketch-on-face') => ({
      id,
      label: id,
      title: id,
      disabled: false,
      pressed: false
    });
    const { container } = renderCard(
      { ...NOTHING, faceSelected: true, bodyCount: 1 },
      {
        initialView: 'simple',
        pickSummary: '1 face',
        pick: {
          label: textLabelSegments('Bracket · Top face'),
          verbs: [
            verb('action:sketch-on-face'),
            verb('tool:hole'),
            verb('tool:shell')
          ],
          anchor: 'selection',
          onVerb: vi.fn(),
          onClear: vi.fn()
        }
      }
    );
    openDrawer();
    const listed = foldTools(container);
    // The rail beside the list already draws these three.
    expect(listed).not.toContain('sketch');
    expect(listed).not.toContain('hole');
    expect(listed).not.toContain('shell');
    expect(listed).toContain('draft');
    // The advanced sheet still lists every tool, to pin from.
    fireEvent.click(screen.getByRole('button', { name: /^All tools & pins/ }));
    expect(foldTools(container)).toEqual(
      expect.arrayContaining(['sketch', 'hole', 'shell'])
    );
  });

  it.each([
    // The button stands 200px above the stage's foot, with room to rise.
    { toggleBottom: 500, lift: '200px' },
    // Higher than the frame allows: the list stops at the frame's top.
    { toggleBottom: 100, lift: '300px' },
    // At the foot already: nothing to lift.
    { toggleBottom: 700, lift: '0px' }
  ])(
    'stands the simple list level with More tools ($toggleBottom)',
    ({ toggleBottom, lift }) => {
      const rect = vi
        .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
        .mockImplementation(function (this: HTMLElement) {
          if (this.classList.contains('command-flyout')) {
            return { top: 400, bottom: 700, height: 300 } as DOMRect;
          }
          if (this.classList.contains('command-more-toggle')) {
            return {
              top: toggleBottom - 30,
              bottom: toggleBottom,
              height: 30
            } as DOMRect;
          }
          return { top: 0, bottom: 0, height: 0 } as DOMRect;
        });
      const style = window.getComputedStyle;
      const computed = vi
        .spyOn(window, 'getComputedStyle')
        .mockImplementation((element, pseudo) =>
          (element as HTMLElement).classList.contains('command-flyout')
            ? ({ maxHeight: '600px' } as CSSStyleDeclaration)
            : style(element, pseudo)
        );
      try {
        const { container } = renderCard(NOTHING, { initialView: 'simple' });
        openDrawer();
        const flyout = container.querySelector<HTMLElement>('.command-flyout')!;
        expect(flyout.style.getPropertyValue('--flyout-lift')).toBe(lift);
        // The advanced sheet keeps the stage's full height.
        fireEvent.click(
          screen.getByRole('button', { name: /^All tools & pins/ })
        );
        expect(flyout.style.getPropertyValue('--flyout-lift')).toBe('');
      } finally {
        rect.mockRestore();
        computed.mockRestore();
      }
    }
  );

  it('greys a tool that cannot run but still lets it move and pin', () => {
    const { container, onLaunchTool } = renderCard();
    layOutPins(container);
    const extrude = screen.getByRole('button', {
      name: 'Extrude (E) — Create a sketch first'
    });
    // A press is refused; a drag is not, so a greyed pin still reorders.
    fireEvent.click(extrude);
    expect(onLaunchTool).not.toHaveBeenCalled();
    expect(extrude).toHaveAttribute('draggable', 'true');
    const transfer = dataTransfer();
    fireEvent.dragStart(extrude, { dataTransfer: transfer });
    dragAt('drop', container.querySelector('.command-rail-pins')!, transfer, 0);
    expect(railTools(container)[0]).toBe('extrude');
  });

  it('shows an empty slot to drop on once every pin is gone', () => {
    const { container } = renderCard(NOTHING, { initialPins: [] });
    expect(railTools(container)).toEqual([]);
    expect(container.querySelector('.command-rail-empty')).not.toBeNull();
  });

  it('names the groups a short flyout hides below its fold', () => {
    // F017: at a laptop height Pattern sat wholly under the fold, marked
    // only by a 10px shade, and read as missing. happy-dom lays nothing
    // out, so the flyout is given a 300px window onto 120px groups.
    const proto = HTMLElement.prototype;
    const names = [
      'scrollHeight',
      'clientHeight',
      'scrollTop',
      'offsetTop',
      'offsetHeight'
    ] as const;
    const saved = names.map(
      (name) => [name, Object.getOwnPropertyDescriptor(proto, name)] as const
    );
    let scrolled = 0;
    const flyoutOf = (element: HTMLElement) =>
      element.classList.contains('command-flyout-list');
    const define = (name: string, get: (this: HTMLElement) => number) =>
      Object.defineProperty(proto, name, {
        configurable: true,
        get
      });
    define('scrollHeight', function () {
      return flyoutOf(this) ? TOOL_GROUPS.length * 120 : 0;
    });
    define('clientHeight', function () {
      return flyoutOf(this) ? 300 : 0;
    });
    define('scrollTop', function () {
      return flyoutOf(this) ? scrolled : 0;
    });
    define('offsetTop', function () {
      const index = TOOL_GROUPS.findIndex(
        (group) => group.label === this.dataset.group
      );
      return index < 0 ? 0 : index * 120;
    });
    define('offsetHeight', () => 20);
    const scrollTo = vi.fn();
    const originalScrollTo = proto.scrollTo;
    proto.scrollTo = scrollTo as typeof proto.scrollTo;
    try {
      const { container } = renderCard();
      fireEvent.click(screen.getByRole('button', { name: /^More tools/ }));
      // Headings whose foot is past 300px are out of sight.
      const hidden = TOOL_GROUPS.filter(
        (_group, index) => index * 120 + 20 > 300
      ).map((group) => group.label);
      expect(hidden.length).toBeGreaterThan(0);
      expect(hidden).toContain('Pattern');
      const cue = screen.getByRole('button', {
        name: `Scroll to ${hidden.join(', ')}`
      });
      // One name and a count: the single column has no room for a list.
      expect(cue).toHaveTextContent(
        `More: ${hidden[0]}${hidden.length > 1 ? ` +${hidden.length - 1}` : ''}`
      );
      expect(container.querySelector('.command-flyout')).toHaveClass(
        'has-more-below'
      );
      fireEvent.click(cue);
      const first = TOOL_GROUPS.findIndex((group) => group.label === hidden[0]);
      expect(scrollTo).toHaveBeenCalledWith({
        top: first * 120 - 4,
        behavior: 'smooth'
      });
      // Scrolled to the end, nothing is hidden and the cue goes.
      scrolled = TOOL_GROUPS.length * 120;
      fireEvent.scroll(container.querySelector('.command-flyout-list')!);
      expect(
        screen.queryByRole('button', { name: /^Scroll to/ })
      ).not.toBeInTheDocument();
    } finally {
      proto.scrollTo = originalScrollTo;
      for (const [name, descriptor] of saved) {
        if (descriptor) Object.defineProperty(proto, name, descriptor);
        else Reflect.deleteProperty(proto, name);
      }
    }
  });

  it('shows no fold cue when every group fits', () => {
    renderCard();
    openDrawer();
    expect(
      screen.queryByRole('button', { name: /^Scroll to/ })
    ).not.toBeInTheDocument();
  });

  describe('the rail as one tab stop', () => {
    const tabStops = (container: HTMLElement) =>
      Array.from(
        container.querySelectorAll<HTMLElement>('button.command-rail')
      )
        .filter((button) => button.getAttribute('tabindex') === '0')
        .map((button) => button.getAttribute('aria-label'));

    it('is a vertical toolbar with a single stop, on its first tool', () => {
      const { container } = renderCard();
      const rail = screen.getByRole('toolbar', { name: 'Feature tools' });
      expect(rail).toHaveAttribute('aria-orientation', 'vertical');
      expect(rail).toHaveAttribute('data-rail', 'build');
      // Twelve buttons, one stop: Tab passes the rail in one press.
      expect(
        container.querySelectorAll('button.command-rail').length
      ).toBeGreaterThan(8);
      expect(tabStops(container)).toEqual([
        expect.stringMatching(/^Sketch/)
      ]);
    });

    it('walks the tools, greyed ones included, with the arrow keys', () => {
      const { container } = renderCard();
      const sketch = screen.getByRole('button', { name: /^Sketch/ });
      sketch.focus();
      fireEvent.keyDown(sketch, { key: 'ArrowDown' });
      // Extrude cannot run (no profile) and is greyed by aria: still a
      // stop, and its name carries the reason.
      const extrude = screen.getByRole('button', { name: /^Extrude/ });
      expect(greyed(extrude)).toBe(true);
      expect(extrude).toHaveFocus();
      expect(extrude).toHaveAccessibleName(/ — .+/);
      expect(tabStops(container)).toEqual([
        expect.stringMatching(/^Extrude/)
      ]);
      fireEvent.keyDown(extrude, { key: 'End' });
      expect(screen.getByRole('button', { name: /^More tools/ })).toHaveFocus();
      fireEvent.keyDown(document.activeElement!, { key: 'Home' });
      expect(sketch).toHaveFocus();
    });

    it('keeps the drawer out of the rail’s stops, in the tab order', () => {
      const { container } = renderCard();
      openDrawer();
      const row = container.querySelector<HTMLElement>('.command-tile')!;
      expect(row).not.toHaveAttribute('tabindex');
      expect(screen.getByRole('searchbox', { name: 'Find a tool' })).toBe(
        container.querySelector('.command-flyout input')
      );
      // An arrow in the drawer's search stays the field's.
      const search = screen.getByRole('searchbox', { name: 'Find a tool' });
      search.focus();
      fireEvent.keyDown(search, { key: 'ArrowDown' });
      expect(search).toHaveFocus();
    });

    it('leaves Alt+arrow to the pin it reorders', () => {
      const onPins = vi.fn<(pins: ToolId[]) => void>();
      renderCard(NOTHING, { onPins });
      const sketch = screen.getByRole('button', { name: /^Sketch/ });
      sketch.focus();
      fireEvent.keyDown(sketch, { key: 'ArrowDown', altKey: true });
      expect(onPins).toHaveBeenCalledOnce();
      expect(onPins.mock.calls[0]![0].indexOf('sketch')).toBe(1);
    });
  });

  describe('the docked drawer', () => {
    it('names itself and closes from its own button', () => {
      renderCard();
      openDrawer();
      const drawer = screen.getByRole('group', { name: 'Tools drawer' });
      const toggle = screen.getByRole('button', { name: /^More tools/ });
      expect(toggle).toHaveAttribute('aria-controls', drawer.id);
      fireEvent.click(
        within(drawer).getByRole('button', { name: 'Close tools drawer' })
      );
      expect(
        screen.queryByRole('group', { name: 'Tools drawer' })
      ).toBeNull();
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
      // The keyboard goes back to the button that opens it.
      expect(toggle).toHaveFocus();
    });

    describe('on a short stage', () => {
      // The stylesheet draws the close button beside the search at this
      // height; the markup's order is what Tab follows.
      let short = false;
      const listeners = new Set<() => void>();
      const setShort = (next: boolean) => {
        short = next;
        act(() => listeners.forEach((listener) => listener()));
      };
      beforeEach(() => {
        short = false;
        listeners.clear();
        vi.stubGlobal(
          'matchMedia',
          (query: string) =>
            ({
              get matches() {
                return short && query === '(max-height: 540px)';
              },
              media: query,
              addEventListener: (_: string, listener: () => void) =>
                listeners.add(listener),
              removeEventListener: (_: string, listener: () => void) =>
                listeners.delete(listener)
            }) as unknown as MediaQueryList
        );
      });
      afterEach(() => vi.unstubAllGlobals());

      const closeFollowsSearch = () => {
        const close = screen.getByRole('button', {
          name: 'Close tools drawer'
        });
        const search = screen.getByRole('searchbox', { name: 'Find a tool' });
        return Boolean(
          search.compareDocumentPosition(close) &
          Node.DOCUMENT_POSITION_FOLLOWING
        );
      };

      it('puts the close button after the search and filters it is drawn beside', () => {
        renderCard();
        openDrawer();
        expect(closeFollowsSearch()).toBe(false);
        setShort(true);
        expect(closeFollowsSearch()).toBe(true);
        const close = screen.getByRole('button', {
          name: 'Close tools drawer'
        });
        const filters = within(
          screen.getByRole('group', { name: 'Show tools' })
        ).getAllByRole('button');
        expect(
          filters.at(-1)!.compareDocumentPosition(close) &
            Node.DOCUMENT_POSITION_FOLLOWING
        ).toBeTruthy();
        // Before the tools, though: it is the head's last stop.
        expect(
          close.compareDocumentPosition(
            document.querySelector('.command-flyout-list')!
          ) & Node.DOCUMENT_POSITION_FOLLOWING
        ).toBeTruthy();
        setShort(false);
        expect(closeFollowsSearch()).toBe(false);
      });

      it('keeps the focus on the close button when the stage changes height', () => {
        renderCard();
        openDrawer();
        screen.getByRole('button', { name: 'Close tools drawer' }).focus();
        setShort(true);
        expect(
          screen.getByRole('button', { name: 'Close tools drawer' })
        ).toHaveFocus();
        setShort(false);
        expect(
          screen.getByRole('button', { name: 'Close tools drawer' })
        ).toHaveFocus();
        // The search's focus is its own: the move does not take it.
        const search = screen.getByRole('searchbox', { name: 'Find a tool' });
        search.focus();
        setShort(true);
        expect(search).toHaveFocus();
      });

      it('leaves the simple view its title at the head', () => {
        short = true;
        renderCard(NOTHING, { initialView: 'simple' });
        openDrawer();
        const drawer = screen.getByRole('group', { name: 'Tools drawer' });
        expect(drawer.firstElementChild).toHaveClass('command-flyout-title');
      });
    });

    it('has its close button in the simple view too', () => {
      renderCard(NOTHING, { initialView: 'simple' });
      openDrawer();
      expect(
        screen.getByRole('button', { name: 'Close tools drawer' })
      ).toBeInTheDocument();
    });

    it('closes on Escape from its button, not only from inside', () => {
      const onKeyDown = vi.fn<(key: string) => void>();
      const onLaunchTool = vi.fn();
      render(
        // The workspace's Escape ladder, above the rail.
        <div onKeyDown={(event) => onKeyDown(event.key)}>
          <Harness selection={NOTHING} onLaunchTool={onLaunchTool} />
        </div>
      );
      openDrawer();
      const toggle = screen.getByRole('button', { name: /^More tools/ });
      fireEvent.keyDown(toggle, { key: 'Escape' });
      expect(
        screen.queryByRole('group', { name: 'Tools drawer' })
      ).toBeNull();
      // The key was the drawer's: the workspace does not also act on it.
      expect(onKeyDown).not.toHaveBeenCalled();
      // Closed, Escape is the workspace's again.
      fireEvent.keyDown(toggle, { key: 'Escape' });
      expect(onKeyDown).toHaveBeenCalledWith('Escape');
    });
  });

  describe('the rail a pick has taken', () => {
    const pick = (): SelectionCalloutContent => ({
      label: textLabelSegments('Bracket · Top face'),
      verbs: [
        {
          id: 'tool:shell',
          label: 'Shell',
          title: 'Hollow the body',
          disabled: false,
          pressed: false
        }
      ],
      anchor: 'selection',
      onVerb: vi.fn(),
      onClear: vi.fn()
    });

    it.each([
      [{ ...NOTHING, faceSelected: true, bodyCount: 1 }, '1 face', 'Face'],
      [{ ...NOTHING, edgeCount: 1, bodyCount: 1 }, '1 edge', 'Edge'],
      [{ ...NOTHING, edgeCount: 8, bodyCount: 1 }, '8 edges', 'Edge×8'],
      [{ ...NOTHING, bodyCount: 1 }, '1 body', 'Body'],
      [{ ...NOTHING, bodyCount: 3 }, '3 bodies', 'Body×3'],
      [{ ...NOTHING, regionCount: 2 }, '2 regions', 'Region×2']
    ] as const)(
      'says what its tools act on: %o reads %s',
      (selection, summary, heading) => {
        const { container } = renderCard(selection, {
          pickSummary: summary,
          pick: pick()
        });
        const rail = screen.getByRole('toolbar', { name: 'Feature tools' });
        // The same toolbar, marked as the selection's rather than Build's.
        expect(rail).toHaveAttribute('data-rail', 'selection');
        const shown = Array.from(
          container.querySelectorAll(
            '.selection-rail-heading > [aria-hidden="true"]'
          )
        )
          .map((part) => part.textContent)
          .join('');
        expect(shown).toBe(heading);
        // The words in full describe the group for assistive tech.
        expect(
          screen.getByRole('group', { name: 'Selection' })
        ).toHaveAccessibleDescription(`Tools for the selection: ${summary}`);
      }
    );

    it('offers the same verbs in the same order under the heading', () => {
      renderCard(
        { ...NOTHING, faceSelected: true, bodyCount: 1 },
        { pickSummary: '1 face', pick: pick() }
      );
      expect(
        within(screen.getByRole('group', { name: 'Selection' }))
          .getAllByRole('button')
          .map((button) => button.getAttribute('aria-label'))
      ).toEqual(['Deselect all', 'Selection: Shell']);
    });

    it('is one tab stop as well, entered on Deselect all', () => {
      const { container } = renderCard(
        { ...NOTHING, faceSelected: true, bodyCount: 1 },
        { pickSummary: '1 face', pick: pick() }
      );
      const stops = Array.from(
        container.querySelectorAll<HTMLElement>('button.command-rail')
      ).filter((button) => button.getAttribute('tabindex') === '0');
      expect(stops.map((button) => button.getAttribute('aria-label'))).toEqual(
        ['Deselect all']
      );
      stops[0]!.focus();
      fireEvent.keyDown(stops[0]!, { key: 'ArrowDown' });
      expect(
        screen.getByRole('button', { name: 'Selection: Shell' })
      ).toHaveFocus();
    });
  });

  it('says a suggested tool is a suggestion, in its name and its help', () => {
    const { container } = renderCard();
    const suggested = container.querySelector<HTMLElement>(
      'button.command-rail.is-suggested'
    )!;
    // The dot on the button is the only other mark of it.
    expect(suggested).toHaveAccessibleName(
      /^Chamfer.* — .*\. Suggested for this step — drag up to pin$/
    );
    // Still found by the tool's name, as every other button of it is.
    expect(screen.getByRole('button', { name: /^Chamfer/ })).toBe(suggested);
    expect(
      screen.getByRole('group', { name: 'Suggested' })
    ).toContainElement(suggested);
  });
});
