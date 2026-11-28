import { describe, expect, it } from 'vitest';
import { drawnOffsetReporter } from './drawnOffsetReport';

function recorder() {
  const reports: (number | null)[] = [];
  return { reports, report: drawnOffsetReporter((v) => reports.push(v)) };
}

describe('drawnOffsetReporter', () => {
  it('reports each drawn offset once, as it changes', () => {
    const { reports, report } = recorder();
    report(1);
    report(1);
    report(3);
    expect(reports).toEqual([1, 3]);
  });

  it('keeps the last drawn mesh when a deformation is rejected', () => {
    // Pulled to +3 past the cut, then pushed past zero width in one move:
    // the viewer keeps drawing +3 and reports nothing new, so the note
    // stays for as long as that clipped mesh is on screen.
    const { reports, report } = recorder();
    report(3);
    expect(reports).toEqual([3]);
  });

  it('reports the part restored after a refused release', () => {
    // The release queues the displacement, the host refuses it, and the
    // viewer restores the original mesh: nothing is drawn moved any more.
    const { reports, report } = recorder();
    report(2);
    report(null);
    expect(reports).toEqual([2, null]);
    // A restore with nothing drawn says nothing.
    report(null);
    expect(reports).toEqual([2, null]);
  });

  it('treats a zero or unreadable offset as the part itself', () => {
    const { reports, report } = recorder();
    report(0);
    report(Number.NaN);
    expect(reports).toEqual([]);
    report(2);
    report(0);
    expect(reports).toEqual([2, null]);
  });
});
