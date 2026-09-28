import { act, render, screen } from '@testing-library/react';
import type { MutableRefObject } from 'react';
import { describe, expect, it } from 'vitest';
import { MoveInstruction, MoveOverlay } from './DirectModelingOverlays';

type LiveValues = MutableRefObject<
  | ((
      translation: { x: number; y: number; z: number },
      rotationDeg: { x: number; y: number; z: number },
      snap: { move: number; rotate: number }
    ) => void)
  | null
>;
type LiveSnap = MutableRefObject<
  ((snap: { move: number; rotate: number }) => void) | null
>;

const zero = { x: 0, y: 0, z: 0 };

describe('Move overlay', () => {
  // The panel anchors in the right lane and the banner rides the viewport,
  // so they are two elements; the one drag sink still reaches both.
  it('renders the panel without the banner, and forwards live snaps to it', () => {
    const liveValuesRef: LiveValues = { current: null };
    const liveSnapRef: LiveSnap = { current: null };
    const { container } = render(
      <>
        <MoveInstruction units="mm" snap={null} liveSnapRef={liveSnapRef} />
        <div className="lane">
          <MoveOverlay
            bodyName="Box"
            values={{ translation: zero, rotationDeg: zero }}
            units="mm"
            snap={null}
            onChange={() => {}}
            onConfirm={() => {}}
            onCancel={() => {}}
            liveValuesRef={liveValuesRef}
            liveSnapRef={liveSnapRef}
          />
        </div>
      </>
    );
    const lane = container.querySelector('.lane')!;
    expect(lane.querySelector('.extrude-instruction')).toBeNull();
    expect(
      lane.querySelector('form.extrude-controller.move-controller')
    ).not.toBeNull();
    expect(screen.getByRole('status').textContent).toContain('whole steps');

    act(() => {
      liveValuesRef.current?.({ x: 5, y: 0, z: 0 }, zero, {
        move: 5,
        rotate: 15
      });
    });
    expect(screen.getByRole('status').textContent).toContain('5 mm · 15°');
    expect(screen.getByLabelText<HTMLInputElement>('Move X in mm').value).toBe(
      '5'
    );
  });
});
