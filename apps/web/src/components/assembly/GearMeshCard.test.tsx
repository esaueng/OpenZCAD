import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import { createProjectDocument, type GearInput } from '@openzcad/document-core';
import { toUserId, type BodyId, type FeatureNode } from '@openzcad/shared';
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

/**
 * A pinion, a wheel (or `wheel` overrides) and a box, all three parts;
 * `plate: false` leaves the box out of the assembly.
 */
function renderGears(wheel: Partial<GearInput> = {}, plate = true) {
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
        ...(plate
          ? [
              {
                componentId: 'comp_plate',
                name: 'Plate',
                bodyId: c,
                grounded: false
              }
            ]
          : []),
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
    { name: 'Place gears' },
    // The first open imports the card's chunk, slow under a parallel run.
    { timeout: LAZY_LOOKUP_MS }
  );

describe('Place gears card', () => {
  it(
    'offers the action in Joints, and preselects an additive gear pair',
    async () => {
      renderGears();
      const joints = screen.getByRole('region', { name: 'Joints' });
      expect(
        within(joints).getByRole('button', { name: 'Place gears' })
      ).toBeVisible();
      expect(
        screen.queryByRole('button', { name: 'Place selected gears' })
      ).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: /^Wheel\b/ }));
      fireEvent.click(screen.getByRole('button', { name: /^Pinion\b/ }), {
        ctrlKey: true
      });
      expect(getAssemblyRuntime().selectedComponentIds).toEqual([
        'comp_b',
        'comp_a'
      ]);
      expect(screen.getByRole('button', { name: /^Wheel\b/ })).toHaveAttribute(
        'aria-pressed',
        'true'
      );
      fireEvent.click(
        screen.getByRole('button', { name: 'Place selected gears' })
      );
      const form = await card();
      expect(
        within(form).getByRole('combobox', { name: 'Gear that stays put' })
      ).toHaveValue('comp_b');
      expect(
        within(form).getByRole('combobox', { name: 'Gear that meshes with it' })
      ).toHaveValue('comp_a');
      // With a part to mount them on, the pair starts on Turn together;
      // Fixed together is one choice away.
      const motion = within(form).getByRole('combobox', {
        name: 'How the pair moves'
      });
      expect(motion).toHaveValue('coupled');
      fireEvent.change(motion, { target: { value: 'fixed' } });
      expect(within(form).getByText(/pair stays fixed together/)).toBeVisible();
    },
    LAZY_TEST_TIMEOUT_MS
  );

  it('drops the shortcut for a non-gear, deselection, or a third part', () => {
    renderGears();
    const wheel = screen.getByRole('button', { name: /^Wheel\b/ });
    const pinion = screen.getByRole('button', { name: /^Pinion\b/ });
    const plate = screen.getByRole('button', { name: /^Plate\b/ });
    const shortcut = () =>
      screen.queryByRole('button', { name: 'Place selected gears' });
    fireEvent.click(wheel);
    fireEvent.click(plate, { metaKey: true });
    expect(shortcut()).toBeNull();
    fireEvent.click(wheel);
    fireEvent.click(pinion, { metaKey: true });
    expect(shortcut()).toBeVisible();
    fireEvent.click(plate, { ctrlKey: true });
    expect(shortcut()).toBeNull();
    fireEvent.click(plate, { ctrlKey: true });
    expect(shortcut()).toBeVisible();
    fireEvent.click(pinion, { metaKey: true });
    expect(shortcut()).toBeNull();
    expect(getAssemblyRuntime().selectedComponentId).toBe('comp_b');
    act(() => assemblyRuntime.selectJoint('joint_test'));
    expect(getAssemblyRuntime().selectedComponentIds).toEqual([]);
  });

  it(
    'offers Place gears in Joints once two parts are gears, and lists only the gears',
    { timeout: LAZY_TEST_TIMEOUT_MS },
    async () => {
      renderGears();
      fireEvent.click(screen.getByRole('button', { name: 'Place gears' }));
      const form = await card();
      const base = within(form).getByRole('combobox', {
        name: 'Gear that stays put'
      });
      expect(base).toHaveValue('comp_a');
      expect(
        within(base).queryByRole('option', { name: /^Plate\b/ })
      ).toBeNull();
      expect(
        within(form).getByRole('combobox', { name: 'Gear that meshes with it' })
      ).toHaveValue('comp_b');
      expect(within(form).getByText('Centre distance')).toBeInTheDocument();
      expect(within(form).getByText('60 mm')).toBeInTheDocument();
      expect(within(form).getByText('0.5, the other way')).toBeInTheDocument();
    }
  );

  it(
    'fixes the base and saves one meshing rigid joint',
    { timeout: LAZY_TEST_TIMEOUT_MS },
    async () => {
      const { commands, rerender, status } = renderGears();
      fireEvent.click(screen.getByRole('button', { name: 'Place gears' }));
      const form = await card();
      fireEvent.change(
        within(form).getByRole('combobox', { name: 'How the pair moves' }),
        { target: { value: 'fixed' } }
      );
      fireEvent.click(within(form).getByRole('button', { name: 'Place' }));
      expect(commands.map((c) => c.kind)).toEqual([
        'assembly.component.update',
        'assembly.joint.add'
      ]);
      const joint = (
        commands[1]!.payload as { joint: { kind: string; name: string } }
      ).joint;
      expect(joint.kind).toBe('rigid');
      expect(joint.name).toBe('Gear placement');
      expect(getAssemblyRuntime().gearMesh).toBeNull();
      expect(status.at(-1)).toBe(
        'Gear placement is in place: the gears are fixed in mesh.'
      );
      rerender();
      expect(screen.queryByRole('region', { name: 'Place gears' })).toBeNull();
    }
  );

  it(
    'saves a joint per gear and their coupling as one step when they turn together',
    { timeout: LAZY_TEST_TIMEOUT_MS },
    async () => {
      const { commands, manager, rerender, status } = renderGears();
      fireEvent.click(screen.getByRole('button', { name: 'Place gears' }));
      const form = await card();
      // Turn together is where the card starts when a mount is available.
      expect(
        within(form).getByRole('combobox', { name: 'How the pair moves' })
      ).toHaveValue('coupled');
      // The only other part is offered as the mount, and Place will fix it.
      expect(
        within(form).getByRole('combobox', {
          name: 'Part the gears are mounted on'
        })
      ).toHaveValue('comp_plate');
      expect(
        within(form).getByText(/own joint on Plate, which Place fixes in place/)
      ).toBeVisible();
      expect(within(form).getByText('0.5, the other way')).toBeInTheDocument();
      fireEvent.click(within(form).getByRole('button', { name: 'Place' }));
      expect(commands.map((c) => c.kind)).toEqual(['transaction']);
      const set = manager.document.assembly!;
      expect(set.joints.map((j) => [j.name, j.kind])).toEqual([
        ['Pinion turn', 'revolute'],
        ['Wheel turn', 'revolute']
      ]);
      expect(set.couplings).toHaveLength(1);
      expect(set.couplings![0]!.ratio).toBeCloseTo(-0.5, 12);
      expect(set.components.find((c) => c.id === 'comp_plate')?.grounded).toBe(
        true
      );
      expect(getAssemblyRuntime().gearMesh).toBeNull();
      // The driving joint is selected, ready to drag or play.
      expect(getAssemblyRuntime().selectedJointId).toBe(set.joints[0]!.id);
      expect(status.at(-1)).toBe(
        'Gear ratio is in place: moving one gear moves the other.'
      );
      rerender();
      const details = screen.getByLabelText('Pinion turn details');
      expect(
        within(details).getByText(
          /Gear ratio: moves with Wheel turn · 0\.5 turns per turn, the other way/
        )
      ).toBeVisible();
      // One undo takes all of it back; Remove alone keeps the joints.
      fireEvent.click(
        within(details).getByRole('button', { name: 'Remove Gear ratio' })
      );
      expect(commands.at(-1)?.kind).toBe('assembly.coupling.delete');
      expect(manager.document.assembly!.couplings).toBeUndefined();
      expect(manager.document.assembly!.joints).toHaveLength(2);
      manager.undo();
      manager.undo();
      expect(manager.document.assembly!.joints).toEqual([]);
    }
  );

  it(
    'says that turning together needs a part to mount the gears on',
    { timeout: LAZY_TEST_TIMEOUT_MS },
    async () => {
      renderGears({}, false);
      fireEvent.click(screen.getByRole('button', { name: 'Place gears' }));
      const form = await card();
      // A bare pair starts on Fixed together, the only way it can be saved.
      const motion = within(form).getByRole('combobox', {
        name: 'How the pair moves'
      });
      expect(motion).toHaveValue('fixed');
      expect(within(form).getByRole('button', { name: 'Place' })).toBeEnabled();
      fireEvent.change(motion, { target: { value: 'coupled' } });
      expect(within(form).getByRole('alert')).toHaveTextContent(
        /need a part they are both mounted on/
      );
      expect(
        within(form).queryByRole('combobox', {
          name: 'Part the gears are mounted on'
        })
      ).toBeNull();
      expect(
        within(form).getByRole('button', { name: 'Place' })
      ).toBeDisabled();
    }
  );

  it(
    'warns on the joint and in the reopened card when a gear’s teeth change',
    { timeout: LAZY_TEST_TIMEOUT_MS },
    async () => {
      const { manager, rerender } = renderGears();
      fireEvent.click(screen.getByRole('button', { name: 'Place gears' }));
      fireEvent.click(
        within(await card()).getByRole('button', { name: 'Place' })
      );
      rerender();
      const details = () => screen.getByLabelText('Pinion turn details');
      expect(within(details()).queryByRole('status')).toBeNull();
      // The wheel goes from 40 to 45 teeth; the coupling keeps 20/40.
      const wheel = Object.values(manager.document.nodes).find(
        (node) => node.kind === 'feature' && node.name === 'Wheel'
      ) as FeatureNode;
      manager.execute(
        commandFactories.updateFeature({
          featureId: wheel.featureId,
          data: { teeth: 45 }
        })
      );
      rerender();
      expect(within(details()).getByRole('status')).toHaveTextContent(
        'Pinion and Wheel no longer match Gear ratio: their teeth now give 0.4444 turns per turn, and it was placed for 0.5 turns per turn. Remove it and place the gears again.'
      );
      expect(manager.document.assembly!.couplings![0]!.ratio).toBeCloseTo(
        -0.5,
        12
      );
      // Reopened on the same pair, the card says the same.
      fireEvent.click(screen.getByRole('button', { name: 'Place gears' }));
      const reopened = await card();
      expect(within(reopened).getByRole('status')).toHaveTextContent(
        /no longer match Gear ratio/
      );
      expect(
        within(reopened).getByRole('button', { name: 'Place' })
      ).toBeDisabled();
      // Back at the count it was placed with, both read as plain coupled.
      manager.execute(
        commandFactories.updateFeature({
          featureId: wheel.featureId,
          data: { teeth: 40 }
        })
      );
      rerender();
      expect(within(reopened).queryByRole('status')).toBeNull();
      expect(
        within(reopened).getByText(/already moves this pair together/)
      ).toBeVisible();
    }
  );

  it(
    'explains why a pair cannot mesh and keeps Place off',
    { timeout: LAZY_TEST_TIMEOUT_MS },
    async () => {
      renderGears({ pitch: 2.5 });
      fireEvent.click(screen.getByRole('button', { name: 'Place gears' }));
      const form = await card();
      expect(within(form).getByRole('alert')).toHaveTextContent(
        'Their modules differ (2 and 2.5); meshing gears need the same module or pitch.'
      );
      expect(
        within(form).getByRole('button', { name: 'Place' })
      ).toBeDisabled();
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
      fireEvent.click(screen.getByRole('button', { name: 'Place gears' }));
      const form = await card();
      expect(within(form).getByRole('alert')).toHaveTextContent(
        /^The gear that stays put reaches 1 mm past the other gear’s root circle/
      );
      expect(
        within(form).getByRole('button', { name: 'Place' })
      ).toBeDisabled();
    }
  );
});
