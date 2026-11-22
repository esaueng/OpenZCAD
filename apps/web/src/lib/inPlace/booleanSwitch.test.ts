import { describe, expect, it } from 'vitest';
import {
  booleanOperandRole,
  booleanOperandRoles,
  booleanOperationSwitch,
  type BodyPick
} from './tools';
import type { BodyId } from '@openzcad/shared';

describe('booleanOperationSwitch (#1654)', () => {
  it('switches a running boolean to the launched operation', () => {
    expect(booleanOperationSwitch('subtract', 'union')).toBe('union');
    expect(booleanOperationSwitch('union', 'subtract')).toBe('subtract');
    expect(booleanOperationSwitch('subtract', 'intersect')).toBe('intersect');
    // The same operation is still the running command's, not a new launch.
    expect(booleanOperationSwitch('union', 'union')).toBe('union');
  });

  it('leaves every other launch to the tool rail', () => {
    expect(booleanOperationSwitch(null, 'union')).toBeNull();
    expect(booleanOperationSwitch('hole', 'union')).toBeNull();
    expect(booleanOperationSwitch('subtract', 'fillet')).toBeNull();
    expect(booleanOperationSwitch('subtract', 'transform')).toBeNull();
  });
});

describe('booleanOperandRoles (U11)', () => {
  const pick = (bodyId: string, x: number): BodyPick => ({
    bodyId: bodyId as BodyId,
    min: { x, y: 0, z: 0 },
    max: { x: x + 10, y: 10, z: 10 }
  });
  const names: Record<string, string> = { body_left: 'Left' };
  const name = (id: BodyId) => names[id];

  it('names the first pick the Base and every later one a Tool', () => {
    expect(booleanOperandRoles([], name)).toEqual({});
    expect(booleanOperandRoles([pick('body_left', 0)], name)).toEqual({
      body_left: {
        role: 'Base',
        name: 'Left',
        min: { x: 0, y: 0, z: 0 },
        max: { x: 10, y: 10, z: 10 }
      }
    });
    const roles = booleanOperandRoles(
      [pick('body_right', 5), pick('body_left', 0), pick('body_top', 20)],
      name
    );
    expect(
      Object.fromEntries(
        Object.entries(roles).map(([id, entry]) => [id, entry.role])
      )
    ).toEqual({ body_right: 'Base', body_left: 'Tool', body_top: 'Tool' });
    // The box it was picked with, to stand on where a preview consumed it;
    // an unnamed body reads as Body.
    expect(roles.body_right).toMatchObject({
      name: 'Body',
      min: { x: 5 },
      max: { x: 15 }
    });
    expect([0, 1, 2].map(booleanOperandRole)).toEqual(['Base', 'Tool', 'Tool']);
  });
});
