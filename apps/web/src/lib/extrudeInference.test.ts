import { describe, expect, it } from 'vitest';
import { toBodyId } from '@openzcad/shared';
import { mixedExtrudeRefusal } from './extrudeInference';

const plate = toBodyId('body_plate');
const block = toBodyId('body_block');

describe('mixedExtrudeRefusal', () => {
  it('accepts profiles that all do the same thing to the same body', () => {
    expect(
      mixedExtrudeRefusal([
        { operation: 'cut', targetBodyId: plate },
        { operation: 'cut', targetBodyId: plate }
      ])
    ).toBeNull();
    expect(
      mixedExtrudeRefusal([
        { operation: 'new-body' },
        { operation: 'new-body' }
      ])
    ).toBeNull();
    expect(mixedExtrudeRefusal([])).toBeNull();
  });

  it('refuses a cut beside an add in one plain sentence', () => {
    const refusal = mixedExtrudeRefusal([
      { operation: 'cut', targetBodyId: plate },
      { operation: 'add', targetBodyId: plate }
    ]);
    expect(refusal).toBe(
      'One selected profile would cut into the body and another would add to the body, so extrude them separately or choose an operation.'
    );
  });

  it('refuses a pocket beside a profile that would land in the air', () => {
    expect(
      mixedExtrudeRefusal([
        { operation: 'cut', targetBodyId: plate },
        { operation: 'new-body' }
      ])
    ).toMatch(/would cut into the body and another would make a new body/);
  });

  it('refuses one operation aimed at two different bodies', () => {
    expect(
      mixedExtrudeRefusal([
        { operation: 'add', targetBodyId: plate },
        { operation: 'add', targetBodyId: block }
      ])
    ).toBe(
      'The selected profiles would add to different bodies, so extrude them separately or choose the target body.'
    );
  });
});
