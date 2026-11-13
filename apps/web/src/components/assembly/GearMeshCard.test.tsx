import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import { createProjectDocument, type GearInput } from '@openzcad/document-core';
import { toUserId, type BodyId } from '@openzcad/shared';
import { recordingExecute, withLiveBodies } from '../../test/assemblyFixture';
import {
  assemblyRuntime,
  getAssemblyRuntime
} from '../../lib/assembly/assemblyRuntime';
import { AssemblyPanel } from './AssemblyPanel';

afterEach(() => {
  act(() => {
    assemblyRuntime.reset();
    assemblyRuntime.setActive(false);
  });
});

function gear(name: string, overrides: Partial<GearInput> = {}): GearInput {
  return {
    name,
    gearType: 'external',
    sizing: 'module',
    pitch: 2,
    teeth: 20,
    faceWidth: 5,
    origin: { x: 0, y: 0, z: 0 },
    axis: { x: 0, y: 0, z: 1 },
    ...overrides
  };
}

/** A pinion, a wheel (or `wheel` overrides) and a box, all three parts. */
function renderGears(wheel: Partial<GearInput> = {}) {
  const manager = new CommandManager(
    createProjectDocument('Gears', toUserId('user_gears'))
  );
  manager.execute(commandFactories.gearBody(gear('Pinion')));
  manager.execute(
    commandFactories.gearBody(gear('Wheel', { teeth: 40, ...wheel }))
  );
  manager.execute(
    commandFactories.addPrimitive({
      name: 'Plate',
      primitiveKind: 'box',
      dimensions: { width: 10, height: 2, depth: 100 }
    })
  );
  const [a, b, c] = manager.document.bodyOrder as [BodyId, BodyId, BodyId];
  manager.execute(
    commandFactories.addAssemblyComponents({
      components: [
        {
          componentId: 'comp_plate',
          name: 'Plate',
          bodyId: c,
          grounded: false
        },
        { componentId: 'comp_a', name: 'Pinion', bodyId: a, grounded: false },
        { componentId: 'comp_b', name: 'Wheel', bodyId: b, grounded: false }
      ]
    })
  );
  const live = () =>
    withLiveBodies(manager.document, {
      [a]: 'Pinion',
      [b]: 'Wheel',
      [c]: 'Plate'
    });
  const recorder = recordingExecute(manager);
  const status: string[] = [];
  const element = () => (
    <AssemblyPanel
      document={live()}
      execute={recorder.execute}
      onStatus={(message) => status.push(message)}
    />
  );
  const view = render(element());
  return {
    ...recorder,
    manager,
    status,
    rerender: () => view.rerender(element())
  };
}

/** The card loads lazily the first time Gears opens it. */
const LAZY_LOOKUP_MS = 10_000;
/** Above the lookup budget, so a slow first import fails at the lookup. */
const LAZY_TEST_TIMEOUT_MS = 20_000;
const card = () =>
  screen.findByRole(
    'region',
    { name: 'Mesh gears' },
    // The first open imports the card's chunk, slow under a parallel run.
    { timeout: LAZY_LOOKUP_MS }
  );

describe('Mesh gears card', () => {
  it(
    'offers Gears once two parts are gears, and lists only the gears',
    { timeout: LAZY_TEST_TIMEOUT_MS },
    async () => {
      renderGears();
      fireEvent.click(screen.getByRole('button', { name: 'Gears' }));
      const form = await card();
      const base = within(form).getByRole('combobox', {
        name: 'Gear that stays put'
      });
      expect(base).toHaveValue('comp_a');
      expect(within(base).queryByRole('option', { name: 'Plate' })).toBeNull();
      expect(
        within(form).getByRole('combobox', { name: 'Gear that meshes with it' })
      ).toHaveValue('comp_b');
      expect(within(form).getByText('Centre distance')).toBeInTheDocument();
      expect(within(form).getByText('60 mm')).toBeInTheDocument();
      expect(within(form).getByText('0.5, the other way')).toBeInTheDocument();
    }
  );

  it(
    'fixes the base and saves one meshing revolute joint',
    { timeout: LAZY_TEST_TIMEOUT_MS },
    async () => {
      const { commands, rerender, status } = renderGears();
      fireEvent.click(screen.getByRole('button', { name: 'Gears' }));
      fireEvent.click(
        within(await card()).getByRole('button', { name: 'Mesh' })
      );
      expect(commands.map((c) => c.kind)).toEqual([
        'assembly.component.update',
        'assembly.joint.add'
      ]);
      const joint = (
        commands[1]!.payload as { joint: { kind: string; name: string } }
      ).joint;
      expect(joint.kind).toBe('revolute');
      expect(joint.name).toBe('Gear mesh');
      expect(getAssemblyRuntime().gearMesh).toBeNull();
      expect(status.at(-1)).toBe('Gear mesh is in place: the gears mesh.');
      rerender();
      expect(screen.queryByRole('region', { name: 'Mesh gears' })).toBeNull();
    }
  );

  it(
    'explains why a pair cannot mesh and keeps Mesh off',
    { timeout: LAZY_TEST_TIMEOUT_MS },
    async () => {
      renderGears({ pitch: 2.5 });
      fireEvent.click(screen.getByRole('button', { name: 'Gears' }));
      const form = await card();
      expect(within(form).getByRole('alert')).toHaveTextContent(
        'Their modules differ (2 and 2.5); meshing gears need the same module or pitch.'
      );
      expect(within(form).getByRole('button', { name: 'Mesh' })).toBeDisabled();
      fireEvent.click(within(form).getByRole('button', { name: 'Cancel' }));
      expect(getAssemblyRuntime().gearMesh).toBeNull();
    }
  );

  it(
    'writes a tip-clearance refusal with the document’s length unit',
    { timeout: LAZY_TEST_TIMEOUT_MS },
    async () => {
      // The wheel's shallow roots leave the pinion's tips 1 mm too long.
      renderGears({ teeth: 20, dedendum: 0.5 });
      fireEvent.click(screen.getByRole('button', { name: 'Gears' }));
      const form = await card();
      expect(within(form).getByRole('alert')).toHaveTextContent(
        /^The gear that stays put reaches 1 mm past the other gear’s root circle/
      );
      expect(within(form).getByRole('button', { name: 'Mesh' })).toBeDisabled();
    }
  );
});
