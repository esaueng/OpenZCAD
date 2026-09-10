import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_PANEL_STATE } from '../lib/panelState';
import {
  TOOL_GROUPS,
  TOOL_META,
  toolTitle,
  type ToolAvailability,
  type ToolGroup
} from '../lib/tools';
import { ToolBar } from './ToolBar';

const AVAILABILITY: ToolAvailability = {
  sketchCount: 0,
  liveBodyCount: 1,
  exactGeometryReady: true,
  hasEdgeSelected: false
};

function renderToolBar(
  overrides: Partial<Record<ToolGroup, boolean>> = {},
  onToggleGroup = vi.fn()
) {
  render(
    <ToolBar
      activeTool={null}
      availability={AVAILABILITY}
      openGroups={{ ...DEFAULT_PANEL_STATE.toolGroups, ...overrides }}
      onLaunchTool={vi.fn()}
      onToggleGroup={onToggleGroup}
    />
  );
  return { onToggleGroup };
}

describe('ToolBar', () => {
  it('preserves the composed accessible names without native titles', () => {
    renderToolBar();

    const box = screen.getByRole('button', {
      name: toolTitle('box', AVAILABILITY)
    });
    const extrude = screen.getByRole('button', {
      name: toolTitle('extrude', AVAILABILITY)
    });
    expect(box).not.toHaveAttribute('title');
    expect(extrude).toBeDisabled();
    expect(extrude).toHaveAccessibleName('Extrude (E) — Create a sketch first');
  });

  it('names every tile and shows its shortcut', () => {
    renderToolBar();
    const box = screen.getByRole('button', { name: /^Box \(B\)/ });
    expect(box).toHaveTextContent('Box');
    expect(box.querySelector('kbd')).toHaveTextContent('B');
    // The group header carries the context, so the tile keeps the short name.
    const linear = screen.getByRole('button', { name: /^Linear pattern/ });
    expect(linear).toHaveTextContent('Linear');
    expect(linear).not.toHaveTextContent('pattern');
  });

  it('keeps every tool of a folded group on its icon row', () => {
    const { onToggleGroup } = renderToolBar({ bodies: false });
    const bodies = screen.getByRole('group', { name: 'Bodies' });
    const toggle = within(bodies).getByRole('button', { name: 'Bodies' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    const move = within(bodies).getByRole('button', { name: /^Move \(M\)/ });
    expect(move).toHaveClass('compact');
    expect(move).not.toHaveTextContent('Move');
    expect(within(bodies).getAllByRole('button')).toHaveLength(
      1 + TOOL_GROUPS.find((group) => group.id === 'bodies')!.tools.length
    );

    fireEvent.click(toggle);
    expect(onToggleGroup).toHaveBeenCalledWith('bodies');
  });

  it('gives every tool its own icon', () => {
    // A folded group shows icons alone, and two tools with one glyph read as
    // the same tool: compare the rendered markup, not the component names.
    const { container } = render(
      <ToolBar
        activeTool={null}
        availability={AVAILABILITY}
        openGroups={
          Object.fromEntries(
            TOOL_GROUPS.map((group) => [group.id, false])
          ) as Record<ToolGroup, boolean>
        }
        onLaunchTool={vi.fn()}
        onToggleGroup={vi.fn()}
      />
    );
    const glyphs = Array.from(container.querySelectorAll('.tool-tile svg')).map(
      (svg) => svg.innerHTML
    );
    expect(glyphs).toHaveLength(Object.keys(TOOL_META).length);
    expect(new Set(glyphs).size).toBe(glyphs.length);
  });
});
