import { act, fireEvent, render, screen } from '@testing-library/react';
import type { MutableRefObject } from 'react';
import { describe, expect, it } from 'vitest';
import { MoveInstruction } from './DirectModelingOverlays';
import { MoveOverlay } from './MoveOverlay';

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

  // `hidden` lost to `.move-grid { display: grid }`, so a sketch move showed
  // rotation fields its commit then silently dropped.
  it('leaves rotation out of a sketch move entirely', () => {
    const liveValuesRef: LiveValues = { current: null };
    const liveSnapRef: LiveSnap = { current: null };
    render(
      <>
        <MoveInstruction
          units="mm"
          snap={null}
          hideRotation
          liveSnapRef={liveSnapRef}
        />
        <MoveOverlay
          bodyName="Sketch 1"
          values={{ translation: zero, rotationDeg: zero }}
          units="mm"
          snap={null}
          hideRotation
          onChange={() => {}}
          onConfirm={() => {}}
          onCancel={() => {}}
          liveValuesRef={liveValuesRef}
          liveSnapRef={liveSnapRef}
        />
      </>
    );
    expect(screen.queryByRole('group', { name: 'Rotation' })).toBeNull();
    expect(screen.queryByLabelText('Rotate X in degrees')).toBeNull();
    expect(screen.getByRole('group', { name: 'Translation' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Move');

    act(() => {
      liveValuesRef.current?.({ x: 5, y: 0, z: 0 }, zero, {
        move: 5,
        rotate: 15
      });
    });
    const banner = screen.getByRole('status').textContent ?? '';
    expect(banner).toContain('Snaps to 5 mm —');
    expect(banner).not.toContain('15°');
  });

  it('shows a body move its rotation fields', () => {
    render(
      <MoveOverlay
        bodyName="Box"
        values={{ translation: zero, rotationDeg: zero }}
        units="mm"
        snap={null}
        onChange={() => {}}
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );
    expect(screen.getByRole('group', { name: 'Rotation' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe(
      'Move / Rotate'
    );
  });

  it('prints inch as in and drops float noise from live values', () => {
    const liveValuesRef: LiveValues = { current: null };
    const liveSnapRef: LiveSnap = { current: null };
    const { container } = render(
      <>
        <MoveInstruction units="inch" snap={null} liveSnapRef={liveSnapRef} />
        <MoveOverlay
          bodyName="Box"
          values={{ translation: zero, rotationDeg: zero }}
          units="inch"
          snap={null}
          onChange={() => {}}
          onConfirm={() => {}}
          onCancel={() => {}}
          liveValuesRef={liveValuesRef}
          liveSnapRef={liveSnapRef}
        />
      </>
    );
    act(() => {
      liveValuesRef.current?.(
        { x: 0.1 + 0.2, y: 0.3 - 0.1, z: 0 },
        { x: 0, y: 0, z: 0.1 * 3 },
        { move: 0.1, rotate: 0.1 }
      );
    });
    expect(screen.getByRole('status').textContent).toContain(
      'Snaps to 0.1 in · 0.1°'
    );
    expect(
      [...container.querySelectorAll('.extrude-distance-input b')].map(
        (unit) => unit.textContent
      )
    ).toEqual(['in', 'in', 'in', '°', '°', '°']);
    expect(
      screen.getByLabelText<HTMLInputElement>('Move X in inch').value
    ).toBe('0.3');
    expect(
      screen.getByLabelText<HTMLInputElement>('Move Y in inch').value
    ).toBe('0.2');
    expect(
      screen.getByLabelText<HTMLInputElement>('Rotate Z in degrees').value
    ).toBe('0.3');
  });
});

describe('Move overlay entry', () => {
  it('keeps a typed minus sign instead of committing 0, so -5 moves by -5', () => {
    const changes: { x: number; y: number; z: number }[] = [];
    render(
      <MoveOverlay
        bodyName="Box"
        values={{ translation: zero, rotationDeg: zero }}
        units="mm"
        snap={null}
        onChange={(next) => changes.push(next.translation)}
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );
    const field = screen.getByLabelText<HTMLInputElement>('Move X in mm');

    // A number input reads "" while it holds only "-".
    fireEvent.change(field, { target: { value: '' } });
    expect(changes).toEqual([]);

    fireEvent.change(field, { target: { value: '-5' } });
    expect(changes).toEqual([{ x: -5, y: 0, z: 0 }]);
  });

  it('holds Enter while a field is emptied, so it cannot apply the old value', () => {
    let confirmed = 0;
    render(
      <MoveOverlay
        bodyName="Box"
        values={{ translation: { x: 5, y: 0, z: 0 }, rotationDeg: zero }}
        units="mm"
        snap={null}
        onChange={() => {}}
        onConfirm={() => {
          confirmed += 1;
        }}
        onCancel={() => {}}
      />
    );
    const field = screen.getByLabelText<HTMLInputElement>('Move X in mm');
    fireEvent.change(field, { target: { value: '' } });

    // fireEvent returns false when a handler called preventDefault, which is
    // what stops the browser's implicit form submission on Enter.
    expect(fireEvent.keyDown(field, { key: 'Enter' })).toBe(false);
    expect(confirmed).toBe(0);

    fireEvent.change(field, { target: { value: '0' } });
    expect(fireEvent.keyDown(field, { key: 'Enter' })).toBe(true);
  });
});
