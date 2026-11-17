import { fireEvent, render } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stageFootClaim, useStageFootClaim } from './useStageFootClaim';

describe('stageFootClaim', () => {
  it('is the distance from the stage’s bottom edge up to the surface’s top', () => {
    expect(stageFootClaim({ bottom: 844 }, { top: 404, height: 250 })).toBe(
      440
    );
    // Rounded up, so a panel above it never shares a pixel row.
    expect(stageFootClaim({ bottom: 844 }, { top: 403.2, height: 10 })).toBe(
      441
    );
  });

  it('claims nothing for a surface with no height or below the stage', () => {
    expect(stageFootClaim({ bottom: 844 }, { top: 404, height: 0 })).toBe(0);
    expect(stageFootClaim({ bottom: 844 }, { top: 900, height: 40 })).toBe(0);
  });
});

function Card({ shown }: { shown: boolean }) {
  const ref = useRef<HTMLElement | null>(null);
  useStageFootClaim(ref, '--workspace-tour-claim', shown);
  return (
    <div className="viewer-area" data-testid="stage">
      {shown && <section ref={ref} data-testid="card" />}
    </div>
  );
}

describe('useStageFootClaim', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // happy-dom lays nothing out: the stage and the card report where they
  // stand.
  function layOut(top: { value: number }) {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        return this.classList.contains('viewer-area')
          ? DOMRect.fromRect({ x: 0, y: 0, width: 390, height: 844 })
          : DOMRect.fromRect({ x: 72, y: top.value, width: 246, height: 250 });
      }
    );
  }

  it('publishes the claim on the stage and clears it when the surface leaves', () => {
    const top = { value: 404 };
    layOut(top);
    const { getByTestId, rerender } = render(<Card shown />);
    const stage = getByTestId('stage');
    expect(stage.style.getPropertyValue('--workspace-tour-claim')).toBe(
      '440px'
    );
    rerender(<Card shown={false} />);
    expect(stage.style.getPropertyValue('--workspace-tour-claim')).toBe('');
  });

  it('measures again once the card’s entrance ends and on a resize', () => {
    const top = { value: 412 };
    layOut(top);
    const { getByTestId } = render(<Card shown />);
    const stage = getByTestId('stage');
    // Mid-rise, the card stood 8px lower.
    expect(stage.style.getPropertyValue('--workspace-tour-claim')).toBe(
      '432px'
    );
    top.value = 404;
    fireEvent.animationEnd(getByTestId('card'));
    expect(stage.style.getPropertyValue('--workspace-tour-claim')).toBe(
      '440px'
    );
    top.value = 300;
    window.dispatchEvent(new Event('resize'));
    expect(stage.style.getPropertyValue('--workspace-tour-claim')).toBe(
      '544px'
    );
  });

  it('publishes nothing while inactive', () => {
    const top = { value: 404 };
    layOut(top);
    const { getByTestId } = render(<Card shown={false} />);
    expect(
      getByTestId('stage').style.getPropertyValue('--workspace-tour-claim')
    ).toBe('');
  });
});
