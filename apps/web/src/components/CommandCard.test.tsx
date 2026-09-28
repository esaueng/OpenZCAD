import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  FOLD_GROUPS,
  RAIL_GROUPS,
  RAIL_TOOLS,
  remainingTools,
  type CommandSelection
} from '../lib/commandContext';
import { textLabelSegments } from '../lib/topologyLabels';
import { TOOL_META, toolTitle, type ToolAvailability } from '../lib/tools';
import { CommandCard } from './CommandCard';

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

/** The rail with the fold's state held the way App holds it. */
function Harness({
  selection,
  onLaunchTool,
  ...extra
}: Partial<Parameters<typeof CommandCard>[0]> & {
  selection: CommandSelection;
  onLaunchTool(tool: string): void;
}) {
  const [moreOpen, setMoreOpen] = useState(false);
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
    />
  );
}

function renderCard(
  selection: CommandSelection = NOTHING,
  extra: Partial<Parameters<typeof CommandCard>[0]> = {}
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
      (button.getAttribute('aria-label') ?? '').replace(/ (\(.\) )?— .*$/, '')
    )
  );

const railTools = (container: HTMLElement) =>
  toolsOf(
    container.querySelectorAll('button.command-rail:not(.command-more-toggle)')
  );

const foldTools = (container: HTMLElement) =>
  toolsOf(container.querySelectorAll('.command-tile'));

describe('CommandCard', () => {
  it('keeps the palette’s composed accessible names without native titles', () => {
    renderCard();
    const box = screen.getByRole('button', {
      name: toolTitle('box', AVAILABILITY)
    });
    expect(box).not.toHaveAttribute('title');
    expect(box).toHaveClass('command-rail');
    // Extrude is on the rail too, greyed with the reason it cannot run.
    const extrude = screen.getByRole('button', {
      name: 'Extrude (E) — Create a sketch first'
    });
    expect(extrude).toBeDisabled();
    expect(extrude).toHaveClass('command-rail');
    // Revolve waits behind the fold, still by name.
    expect(
      screen.queryByRole('button', {
        name: 'Revolve (R) — Create a sketch first'
      })
    ).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^More tools/ }));
    const revolve = screen.getByRole('button', {
      name: 'Revolve (R) — Create a sketch first'
    });
    expect(revolve).toBeDisabled();
    expect(revolve).toHaveClass('command-tile');
    expect(revolve).toHaveTextContent('Revolve');
  });

  it('is one fixed set of verbs while nothing is picked, Sketch lit', () => {
    const { container } = renderCard();
    // Nothing names the pick here: the selection callout does that.
    expect(container.querySelector('.command-card-head')).toBeNull();
    expect(railTools(container)).toEqual(RAIL_TOOLS);
    const group = screen.getByRole('group', { name: 'Sketch' });
    const sketch = within(group).getByRole('button', {
      name: /^Sketch \(S\)/
    });
    expect(sketch).toHaveClass('is-primary');
    // Icon only: the name and key ride the tooltip.
    expect(sketch).toHaveTextContent('');
    expect(sketch.querySelector('svg')).not.toBeNull();
    // Nothing is picked, so nothing is dimmed.
    expect(container.querySelectorAll('.is-dim')).toHaveLength(0);
  });

  it.each([
    ['body', { ...NOTHING, bodyCount: 1 }],
    ['bodies', { ...NOTHING, bodyCount: 2 }],
    ['face', { ...NOTHING, faceSelected: true, bodyCount: 1 }],
    ['edges', { ...NOTHING, edgeCount: 3, bodyCount: 1 }],
    ['region', { ...NOTHING, regionCount: 1 }]
  ] as const)(
    'keeps every rail button in place when a %s is picked',
    (kind, selection) => {
      const { container } = renderCard(selection);
      fireEvent.click(screen.getByRole('button', { name: /^More tools/ }));
      expect(
        screen.getByRole('navigation', { name: 'Feature tools' })
      ).toHaveAttribute('data-context', kind);
      expect(railTools(container)).toEqual(RAIL_TOOLS);
      expect(foldTools(container)).toEqual(remainingTools());
      expect(container.querySelectorAll('.command-rail-divider')).toHaveLength(
        RAIL_GROUPS.length
      );
    }
  );

  it('dims the tools that do not act on the pick, without removing them', () => {
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
    fireEvent.click(screen.getByRole('button', { name: /^More tools/ }));
    const chamfer = screen.getByRole('button', { name: /^Chamfer/ });
    expect(chamfer).toHaveClass('command-tile');
    expect(chamfer).not.toHaveClass('is-dim');
    expect(container.querySelectorAll('.command-tile.is-dim').length).toBe(
      remainingTools().length - 1
    );
  });

  it('folds every other tool away by default and counts them', () => {
    const { container } = renderCard();
    const fold = screen.getByRole('group', { name: 'All tools' });
    const toggle = within(fold).getByRole('button', { name: /^More tools/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(container.querySelector('.command-flyout')).toBeNull();
    const rest = Object.keys(TOOL_META).length - RAIL_TOOLS.length;
    expect(toggle).toHaveAccessibleName(`More tools (${rest})`);
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(container.querySelectorAll('.command-tile')).toHaveLength(rest);
    // Fixed headings from the palette's own groups.
    expect(
      Array.from(container.querySelectorAll('.command-flyout-heading')).map(
        (node) => node.textContent
      )
    ).toEqual(FOLD_GROUPS.map((group) => group.label));
    fireEvent.click(toggle);
    expect(container.querySelector('.command-flyout')).toBeNull();
  });

  it('launches a tool from the rail or from the flyout', () => {
    const { onLaunchTool } = renderCard({ ...NOTHING, bodyCount: 1 });
    fireEvent.click(screen.getByRole('button', { name: /^Move \(M\)/ }));
    fireEvent.click(screen.getByRole('button', { name: /^More tools/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Sphere/ }));
    expect(onLaunchTool).toHaveBeenNthCalledWith(1, 'transform');
    expect(onLaunchTool).toHaveBeenNthCalledWith(2, 'sphere');
  });

  it.each([
    ['idle', NOTHING],
    ['body', { ...NOTHING, bodyCount: 1 }],
    ['face', { ...NOTHING, faceSelected: true, bodyCount: 1 }],
    ['edges', { ...NOTHING, edgeCount: 2, bodyCount: 1 }]
  ] as const)(
    'in the %s context every tool appears exactly once with the fold open',
    (_kind, selection) => {
      const { container } = renderCard(selection);
      fireEvent.click(screen.getByRole('button', { name: /^More tools/ }));
      const buttons = container.querySelectorAll(
        'button.command-rail:not(.command-more-toggle), .command-tile'
      );
      expect(buttons).toHaveLength(Object.keys(TOOL_META).length);
    }
  );

  it('gives every tool its own icon', () => {
    // The rail shows icons alone, and two tools with one glyph read as the
    // same tool: compare the rendered markup, not the component names.
    const { container } = renderCard();
    fireEvent.click(screen.getByRole('button', { name: /^More tools/ }));
    const glyphs = Array.from(
      container.querySelectorAll(
        'button.command-rail:not(.command-more-toggle) svg, .command-tile svg'
      )
    ).map((svg) => svg.innerHTML);
    expect(glyphs).toHaveLength(Object.keys(TOOL_META).length);
    expect(new Set(glyphs).size).toBe(glyphs.length);
  });
});
