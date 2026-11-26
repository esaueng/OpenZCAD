import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACTIONS, COMPACT_ENTRIES } from '../../lib/actions/registry';
import { commandContextFor } from '../../lib/commandContext';
import type {
  SelectionCalloutVerb,
  SelectionCalloutVerbId
} from '../../lib/selectionCallout';
import type { ToolAvailability } from '../../lib/tools';
import type { CompactBuildProps } from './compactSlots';
import { ContextTray, TRAY_REASON_MS } from './ContextTray';

const READY: ToolAvailability = {
  sketchCount: 0,
  liveBodyCount: 0,
  exactGeometryReady: true,
  hasEdgeSelected: false
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

/** A tap: a touch pointer pressed and released on the element. */
async function tap(element: Element) {
  const user = userEvent.setup();
  await user.pointer({ keys: '[TouchA]', target: element });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Build's context tray", () => {
  it('shows the suggested tools as named icons, with one word for All tools', () => {
    render(
      <ContextTray build={build()} allToolsOpen={false} onAllTools={vi.fn()} />
    );
    const tray = screen.getByRole('group', { name: 'Build tray' });
    expect(tray).toHaveTextContent(/^Tools$/);
    expect(screen.getByRole('button', { name: 'Sketch' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Box' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'All tools' })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
  });

  it('launches a tool, and opens All tools, by taps', async () => {
    const onLaunchTool = vi.fn();
    const onAllTools = vi.fn();
    render(
      <ContextTray
        build={build({ onLaunchTool })}
        allToolsOpen={false}
        onAllTools={onAllTools}
      />
    );
    await tap(screen.getByRole('button', { name: 'Box' }));
    expect(onLaunchTool).toHaveBeenCalledWith('box');
    await tap(screen.getByRole('button', { name: 'All tools' }));
    expect(onAllTools).toHaveBeenCalledTimes(1);
  });

  it('answers a tap on a verb that cannot run with its reason, for a while', () => {
    vi.useFakeTimers();
    const onVerb = vi.fn();
    const verb: SelectionCalloutVerb = {
      id: 'action:offset-face',
      label: 'Offset',
      title: 'Waiting for exact geometry',
      disabled: true,
      pressed: false
    };
    render(
      <ContextTray
        build={build({
          pick: { verbs: [verb], enabled: () => false, onVerb }
        })}
        allToolsOpen={false}
        onAllTools={vi.fn()}
      />
    );
    const button = screen.getByRole('button', { name: 'Selection: Offset' });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(button);
    expect(onVerb).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Waiting for exact geometry'
    );
    act(() => {
      vi.advanceTimersByTime(TRAY_REASON_MS + 10);
    });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it("opens every action it is the compact entry of, by taps only: a pick's verbs", async () => {
    const ids = ACTIONS.filter(
      (entry) => COMPACT_ENTRIES[entry.id] === 'context-tray'
    ).map((entry) => entry.id);
    expect(ids.length).toBeGreaterThan(0);
    const verbIds = ids.map((id): SelectionCalloutVerbId => {
      const rest = id.slice('selection-'.length);
      return rest === 'text-on-face' ||
        rest === 'edit-face' ||
        rest === 'offset-faces'
        ? rest
        : (`action:${rest}` as SelectionCalloutVerbId);
    });
    const verbs = verbIds.map((id): SelectionCalloutVerb => ({
      id,
      label: id,
      title: id,
      disabled: false,
      pressed: false
    }));
    const onVerb = vi.fn();
    render(
      <ContextTray
        build={build({ pick: { verbs, enabled: () => true, onVerb } })}
        allToolsOpen={false}
        onAllTools={vi.fn()}
      />
    );
    for (const id of verbIds) {
      onVerb.mockClear();
      await tap(screen.getByRole('button', { name: `Selection: ${id}` }));
      expect(onVerb, id).toHaveBeenCalledWith(id);
    }
  });
});
