import { fireEvent, render, screen, within } from '@testing-library/react';
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

function renderCard(
  selection: CommandSelection = NOTHING,
  extra: Partial<Parameters<typeof CommandCard>[0]> = {}
) {
  const onLaunchTool = vi.fn();
  const view = render(
    <CommandCard
      selection={selection}
      summary={null}
      activeTool={null}
      availability={AVAILABILITY}
      onLaunchTool={onLaunchTool}
      {...extra}
    />
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
    // Not in the idle rows, so it waits in the grid, still by name.
    const extrude = screen.getByRole('button', {
      name: 'Extrude (E) — Create a sketch first'
    });
    expect(extrude).toBeDisabled();
    expect(extrude).toHaveClass('command-icon');
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
    'in the %s context every tool appears exactly once',
    (_kind, selection) => {
      const { container } = renderCard(selection);
      const buttons = container.querySelectorAll('.command-row, .command-icon');
      expect(buttons).toHaveLength(Object.keys(TOOL_META).length);
    }
  );

  it('gives every tool its own icon', () => {
    // The grid shows icons alone, and two tools with one glyph read as the
    // same tool: compare the rendered markup, not the component names.
    const { container } = renderCard();
    const glyphs = Array.from(
      container.querySelectorAll('.command-row svg, .command-icon svg')
    ).map((svg) => svg.innerHTML);
    expect(glyphs).toHaveLength(Object.keys(TOOL_META).length);
    expect(new Set(glyphs).size).toBe(glyphs.length);
  });
});
