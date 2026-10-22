import { expect, it } from 'vitest';
import { readCylinderCapX } from './support/cylinderProbe';

type ProbeDetail = {
  surface: 'wall';
  select: false;
  resolve: (
    geometry: { axisStart?: { x: number }; axisEnd?: { x: number } } | null
  ) => void;
};

it('retries a canvas that has not registered its hook yet', () => {
  const canvas = new EventTarget();
  expect(readCylinderCapX(canvas)).toBeNull();
  canvas.addEventListener('openzcad:e2e-select-cylinder', (event) => {
    const detail = (event as CustomEvent<ProbeDetail>).detail;
    expect(detail.surface).toBe('wall');
    expect(detail.select).toBe(false);
    detail.resolve({ axisStart: { x: 68 }, axisEnd: { x: 3 } });
  });
  expect(readCylinderCapX(canvas)).toBe(68);
});

it('keeps a missing or incomplete cylinder unready', () => {
  for (const geometry of [null, {}, { axisStart: { x: 68 } }]) {
    const canvas = new EventTarget();
    canvas.addEventListener('openzcad:e2e-select-cylinder', (event) => {
      (event as CustomEvent<ProbeDetail>).detail.resolve(geometry);
    });
    expect(readCylinderCapX(canvas)).toBeNull();
  }
});
