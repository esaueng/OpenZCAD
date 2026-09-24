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

/** The card with the fold's state held the way App holds it. */
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

describe('CommandCard', () => {
  it('keeps the palette’s composed accessible names without native titles', () => {
    renderCard();
    const box = screen.getByRole('button', {
      name: toolTitle('box', AVAILABILITY)
    });
    expect(box).not.toHaveAttribute('title');
    // Not in the idle rows, so it waits behind the fold, still by name.
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
    expect(extrude).toHaveClass('command-icon');
  });

  it('folds every other tool away by default and counts them', () => {
    const { container } = renderCard();
    const fold = screen.getByRole('group', { name: 'All tools' });
    const toggle = within(fold).getByRole('button', { name: /^More tools/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(container.querySelectorAll('.command-icon')).toHaveLength(0);
    // Six idle rows; the rest are behind the fold, and the count says so.
    const rest = Object.keys(TOOL_META).length - 6;
    expect(toggle).toHaveTextContent(`More tools${rest}`);
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveTextContent('All tools');
    expect(container.querySelectorAll('.command-icon')).toHaveLength(rest);
    // A new pick keeps the fold where it was left.
    fireEvent.click(toggle);
    expect(container.querySelectorAll('.command-icon')).toHaveLength(0);
  });

  it('names nothing picked and marks Sketch as the idle verb', () => {
    renderCard();
    expect(
      screen.getByRole('navigation', { name: 'Feature tools' })
    ).toHaveTextContent('Nothing selected');
    const start = screen.getByRole('group', { name: 'Start' });
    const sketch = within(start).getByRole('button', { name: /^Sketch \(S\)/ });
    expect(sketch).toHaveClass('primary');
    expect(sketch).toHaveTextContent('Sketch');
    expect(sketch.querySelector('kbd')).toHaveTextContent('S');
    // Nothing is picked, so there is nothing to clear.
    expect(
      screen.queryByRole('button', { name: 'Clear selection (Esc)' })
    ).toBeNull();
  });

  it('follows the pick: edges put Fillet first, and the header names them', () => {
    const onClear = vi.fn();
    renderCard(
      { ...NOTHING, edgeCount: 3, bodyCount: 1 },
      {
        summary: { label: textLabelSegments('3 edges'), detail: '306 mm' },
        onClear
      }
    );
    const card = screen.getByRole('navigation', { name: 'Feature tools' });
    expect(card).toHaveAttribute('data-context', 'edges');
    expect(card).toHaveTextContent('3 edges');
    expect(card).toHaveTextContent('306 mm');
    const round = screen.getByRole('group', { name: 'Round off' });
    expect(within(round).getByRole('button', { name: /^Fillet/ })).toHaveClass(
      'primary'
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Clear selection (Esc)' })
    );
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('launches a tool from a row or from the grid', () => {
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
      const buttons = container.querySelectorAll('.command-row, .command-icon');
      expect(buttons).toHaveLength(Object.keys(TOOL_META).length);
    }
  );

  it('gives every tool its own icon', () => {
    // The grid shows icons alone, and two tools with one glyph read as the
    // same tool: compare the rendered markup, not the component names.
    const { container } = renderCard();
    fireEvent.click(screen.getByRole('button', { name: /^More tools/ }));
    const glyphs = Array.from(
      container.querySelectorAll('.command-row svg, .command-icon svg')
    ).map((svg) => svg.innerHTML);
    expect(glyphs).toHaveLength(Object.keys(TOOL_META).length);
    expect(new Set(glyphs).size).toBe(glyphs.length);
  });
});
