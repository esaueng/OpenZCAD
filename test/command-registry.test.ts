import { describe, expect, it } from 'vitest';
import {
  COMMANDS,
  PALETTE_GROUPS,
  contextualCommands,
  getCommand,
  searchCommands,
  type CommandContext
} from '../apps/web/src/lib/commands';

function ctx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    sketchCount: 0,
    liveBodyCount: 0,
    selectedBodyCount: 0,
    sketchSelected: false,
    featureSelected: false,
    canUndo: false,
    canRedo: false,
    canExport: false,
    workspace: 'model',
    ...overrides
  };
}

describe('command registry', () => {
  it('has unique command ids', () => {
    const ids = COMMANDS.map((command) => command.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('resolves every palette entry to a registered command', () => {
    for (const group of PALETTE_GROUPS) {
      for (const id of group.commandIds) {
        expect(getCommand(id), `palette references unknown command ${id}`).toBeDefined();
      }
    }
  });

  it('provides a disabled reason whenever a command is unavailable', () => {
    const empty = ctx();
    for (const command of COMMANDS) {
      if (!command.isEnabled(empty)) {
        expect(command.disabledReason(empty), command.id).toBeTruthy();
      }
    }
  });

  it('gates sweep tools on sketches and booleans on body count', () => {
    expect(getCommand('extrude')!.isEnabled(ctx())).toBe(false);
    expect(getCommand('extrude')!.isEnabled(ctx({ sketchCount: 1 }))).toBe(true);
    expect(getCommand('boolean.union')!.isEnabled(ctx({ liveBodyCount: 1 }))).toBe(false);
    expect(getCommand('boolean.union')!.isEnabled(ctx({ liveBodyCount: 2 }))).toBe(true);
    expect(getCommand('move')!.isEnabled(ctx({ liveBodyCount: 1 }))).toBe(true);
  });

  it('prioritizes extrude and revolve when a sketch is selected', () => {
    const commands = contextualCommands(
      ctx({ sketchCount: 1, sketchSelected: true, featureSelected: true })
    );
    expect(commands[0]?.id).toBe('extrude');
    expect(commands.map((command) => command.id)).toContain('revolve');
  });

  it('prioritizes move for a single body and booleans for multiple bodies', () => {
    const single = contextualCommands(
      ctx({ liveBodyCount: 2, selectedBodyCount: 1, featureSelected: true })
    );
    expect(single[0]?.id).toBe('move');

    const multi = contextualCommands(
      ctx({ liveBodyCount: 2, selectedBodyCount: 2, featureSelected: true })
    );
    expect(multi[0]?.id).toBe('boolean.union');
    expect(multi.map((command) => command.id)).toContain('boolean.subtract');
  });

  it('never surfaces disabled commands contextually', () => {
    // Two bodies selected but only one live: booleans score > 0 yet stay hidden.
    const context = ctx({ selectedBodyCount: 2, liveBodyCount: 1 });
    const commands = contextualCommands(context);
    expect(commands.every((command) => command.isEnabled(context))).toBe(true);
    expect(commands.map((command) => command.id)).not.toContain('boolean.union');
  });

  it('search ranks prefix matches first and keeps disabled commands listed with reasons', () => {
    const results = searchCommands('ex', ctx());
    expect(results[0]?.command.id).toBe('extrude');
    const extrude = results.find((result) => result.command.id === 'extrude')!;
    expect(extrude.enabled).toBe(false);
    expect(extrude.reason).toMatch(/sketch/i);
  });

  it('search with an empty query lists every command', () => {
    expect(searchCommands('', ctx()).length).toBe(COMMANDS.length);
  });
});
