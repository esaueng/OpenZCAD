import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { CommandSelection } from '../lib/commandContext';
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

const railButtons = (container: HTMLElement) =>
  container.querySelectorAll('button.command-rail:not(.command-more-toggle)');

describe('CommandCard', () => {
  it('keeps the palette’s composed accessible names without native titles', () => {
    renderCard();
    const box = screen.getByRole('button', {
      name: toolTitle('box', AVAILABILITY)
    });
    expect(box).not.toHaveAttribute('title');
    expect(box).toHaveClass('command-rail');
    // Not in the idle rail, so it waits behind the fold, still by name.
    expect(
      screen.queryByRole('button', {
        name: 'Extrude (E) — Create a sketch first'
      })
    ).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^More tools/ }));
    const extrude = screen.getByRole('button', {
      name: 'Extrude (E) — Create a sketch first'
    });
    expect(extrude).toBeDisabled();
    expect(extrude).toHaveClass('command-tile');
    expect(extrude).toHaveTextContent('Extrude');
  });

  it('is the Start tools alone while nothing is picked, Sketch lit', () => {
    const { container } = renderCard();
    // Nothing names the pick here: the selection chip in the bottom lane
    // does that, and the bottom lane says what a click takes.
    expect(container.querySelector('.command-card-head')).toBeNull();
    expect(railButtons(container)).toHaveLength(6);
    const start = screen.getByRole('group', { name: 'Start' });
    const sketch = within(start).getByRole('button', { name: /^Sketch \(S\)/ });
    expect(sketch).toHaveClass('is-primary');
    // Icon only: the name and key ride the tooltip.
    expect(sketch).toHaveTextContent('');
    expect(sketch.querySelector('svg')).not.toBeNull();
  });

  it('follows the pick: edges put Fillet first, in one group', () => {
    const { container } = renderCard(
      { ...NOTHING, edgeCount: 3, bodyCount: 1 },
      {
        summary: { label: textLabelSegments('3 edges'), detail: '306 mm' },
        onClear: vi.fn()
      }
    );
    const card = screen.getByRole('navigation', { name: 'Feature tools' });
    expect(card).toHaveAttribute('data-context', 'edges');
    const round = screen.getByRole('group', { name: 'Round off' });
    expect(within(round).getByRole('button', { name: /^Fillet/ })).toHaveClass(
      'is-primary'
    );
    expect(railButtons(container)).toHaveLength(2);
    // Groups are separated by a divider; one group draws none of its own.
    expect(container.querySelectorAll('.command-rail-divider')).toHaveLength(1);
  });

  it('separates several groups with dividers', () => {
    const { container } = renderCard({ ...NOTHING, bodyCount: 1 });
    for (const label of ['Transform', 'Modify', 'Pattern']) {
      expect(screen.getByRole('group', { name: label })).toBeInTheDocument();
    }
    // Two between the three groups, one before the fold.
    expect(container.querySelectorAll('.command-rail-divider')).toHaveLength(3);
  });

  it('folds every other tool away by default and counts them', () => {
    const { container } = renderCard();
    const fold = screen.getByRole('group', { name: 'All tools' });
    const toggle = within(fold).getByRole('button', { name: /^More tools/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(container.querySelector('.command-flyout')).toBeNull();
    // Six idle tools; the rest are behind the fold, and the name says so.
    const rest = Object.keys(TOOL_META).length - 6;
    expect(toggle).toHaveAccessibleName(`More tools (${rest})`);
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(container.querySelectorAll('.command-tile')).toHaveLength(rest);
    fireEvent.click(toggle);
    expect(container.querySelector('.command-flyout')).toBeNull();
  });

  it('launches a tool from the rail or from the flyout', () => {
    const { onLaunchTool } = renderCard({ ...NOTHING, bodyCount: 1 });
    fireEvent.click(screen.getByRole('button', { name: /^Move \(M\)/ }));
    fireEvent.click(screen.getByRole('button', { name: /^More tools/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Box \(B\)/ }));
    expect(onLaunchTool).toHaveBeenNthCalledWith(1, 'transform');
    expect(onLaunchTool).toHaveBeenNthCalledWith(2, 'box');
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
