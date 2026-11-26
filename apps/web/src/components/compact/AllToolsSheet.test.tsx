import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ACTIONS, COMPACT_ENTRIES } from '../../lib/actions/registry';
import { commandContextFor } from '../../lib/commandContext';
import { toolCommandId } from '../../lib/keymap';
import {
  TOOL_GROUPS,
  TOOL_META,
  type ToolAvailability,
  type ToolId
} from '../../lib/tools';
import { AllToolsSheet } from './AllToolsSheet';
import type { CompactBuildProps } from './compactSlots';

const READY: ToolAvailability = {
  sketchCount: 3,
  closedProfileSketchCount: 3,
  liveBodyCount: 3,
  exactGeometryReady: true,
  hasEdgeSelected: false,
  hasCylindricalFace: true,
  hasSheetMetalBody: true
};

function build(overrides: Partial<CompactBuildProps> = {}): CompactBuildProps {
  return {
    context: commandContextFor({
      edgeCount: 0,
      faceSelected: false,
      bodyCount: 0,
      regionCount: 0
    }),
    pick: null,
    availability: READY,
    activeTool: null,
    recentTools: [],
    pinnedTools: [],
    onLaunchTool: vi.fn(),
    ...overrides
  };
}

async function tap(element: Element) {
  const user = userEvent.setup();
  await user.pointer({ keys: '[TouchA]', target: element });
}

const TOOL_BY_ACTION = new Map(
  TOOL_GROUPS.flatMap((group) => group.tools).map(
    (tool) => [toolCommandId(tool), tool] as const
  )
);

describe('the All tools sheet', () => {
  it('draws the five groups, each tool an icon with one word', () => {
    render(<AllToolsSheet build={build()} onLaunch={vi.fn()} />);
    for (const group of TOOL_GROUPS) {
      const region = screen.getByRole('region', { name: group.label });
      expect(within(region).getAllByRole('button')).toHaveLength(
        group.tools.length
      );
    }
    const csys = screen.getByRole('button', { name: 'Coordinate system' });
    expect(csys).toHaveTextContent(/^Frame$/);
  });

  it('leads with the recent row, and searches', () => {
    render(
      <AllToolsSheet
        build={build({ recentTools: ['hole', 'fillet'] })}
        onLaunch={vi.fn()}
      />
    );
    const recent = screen.getByRole('region', { name: 'Recent' });
    expect(
      within(recent)
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label'))
    ).toEqual(['Hole', 'Fillet']);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search tools' }), {
      target: { value: 'pattern' }
    });
    expect(screen.queryByRole('region', { name: 'Recent' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Pattern' })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search tools' }), {
      target: { value: 'nothing like it' }
    });
    expect(screen.getByRole('status')).toHaveTextContent('No tools match');
  });

  it('says why a tool cannot run rather than launching it', async () => {
    const onLaunch = vi.fn();
    render(
      <AllToolsSheet
        build={build({ availability: { ...READY, liveBodyCount: 0 } })}
        onLaunch={onLaunch}
      />
    );
    const union = screen.getByRole('button', { name: 'Union' });
    expect(union).toHaveAttribute('aria-disabled', 'true');
    await tap(union);
    expect(onLaunch).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Union: Needs at least two bodies'
    );
  });

  it('opens every tool it is the compact entry of, by taps only', async () => {
    const ids = ACTIONS.filter(
      (entry) => COMPACT_ENTRIES[entry.id] === 'all-tools'
    ).map((entry) => entry.id);
    expect(ids).toHaveLength(Object.keys(TOOL_META).length);
    const onLaunch = vi.fn();
    render(<AllToolsSheet build={build()} onLaunch={onLaunch} />);
    for (const id of ids) {
      const tool = TOOL_BY_ACTION.get(id) as ToolId;
      expect(tool, id).toBeDefined();
      onLaunch.mockClear();
      const group = TOOL_GROUPS.find((entry) => entry.tools.includes(tool))!;
      await tap(
        within(screen.getByRole('region', { name: group.label })).getByRole(
          'button',
          { name: TOOL_META[tool].label }
        )
      );
      expect(onLaunch, id).toHaveBeenCalledWith(tool);
    }
  });

  /**
   * A launch is only half a flow: Sketch hands the stage to a sketch
   * session, whose tools, relations and Finish live in the column and the
   * instrument rail, which the compact frame otherwise hides (the review
   * of #2216 found a sketch that could not be finished by touch). This
   * fails when the compact stylesheet stops drawing them while a sketch is
   * open; `test/e2e/compact-build.spec.ts` ("sketches by taps alone")
   * drives the whole flow, plane to Finish to Extrude, with taps only.
   */
  it('keeps a launched sketch finishable in the compact frame', () => {
    const css = readFileSync(
      resolve(__dirname, '../../styles/components/compact-shell.css'),
      'utf8'
    ).replace(/\/\*[\s\S]*?\*\//g, '');
    const hidden = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter((match) => /display:\s*none/.test(match[2]!))
      .flatMap((match) => match[1]!.split(/,(?![^(]*\))/))
      .map((selector) => selector.replace(/\s+/g, ' ').trim());
    // Each hidden rule's subject: its last compound selector.
    const subject = (selector: string) =>
      selector.split(/\s*[\s>+~]\s*(?![^(]*\))/).pop()!;
    for (const selector of hidden) {
      const last = subject(selector);
      if (/^\.workspace-column-float\b/.test(last)) {
        expect(last, 'the sketch column stays drawn').toContain(
          ':not(:has(.sketch-rail))'
        );
      }
      if (/^\.instrument-rail\b/.test(last)) {
        expect(last, 'the relations stay drawn').toContain(
          ':not(:has(> .sketch-relations))'
        );
      }
      expect(last).not.toMatch(
        /^\.(sketch-rail|sketch-relations|workspace-column|workspace-column-(tools|footer|finish))(?![\w-])/
      );
    }
    // Finish, the column's foot, is a finger's size.
    expect(css).toMatch(
      /\.workspace-column-footer\s+\.workspace-column-finish\s*\{[^}]*width:\s*var\(--compact-target\);[^}]*height:\s*var\(--compact-target\);/
    );
  });
});
