import { describe, expect, it } from 'vitest';
import { extrudeSketchGuidance } from './extrudeGuidance';

describe('extrudeSketchGuidance', () => {
  it('names an open sketch instead of asking for a profile that is not there', () => {
    expect(extrudeSketchGuidance([{ name: 'Sketch 02', closed: false }])).toBe(
      'Extrude: Sketch 02 is not closed — close its outline to extrude it.'
    );
  });

  it('points from the open sketch to the closed one', () => {
    expect(
      extrudeSketchGuidance([
        { name: 'Sketch 01', closed: true },
        { name: 'Sketch 02', closed: false }
      ])
    ).toBe(
      'Extrude: Sketch 02 is not closed — click a shaded profile in Sketch 01, or close the outline.'
    );
  });

  it('keeps the plain instruction when every sketch is closed', () => {
    expect(
      extrudeSketchGuidance([
        { name: 'Sketch 01', closed: true },
        { name: 'Sketch 02', closed: true }
      ])
    ).toBe('Extrude: click a shaded profile in the sketch to extrude it.');
  });

  it('lists several open sketches', () => {
    expect(
      extrudeSketchGuidance([
        { name: 'A', closed: false },
        { name: 'B', closed: false },
        { name: 'C', closed: false }
      ])
    ).toBe(
      'Extrude: A, B and C are not closed — close an outline to extrude it.'
    );
  });

  it('asks for a sketch when there is none', () => {
    expect(extrudeSketchGuidance([])).toBe(
      'Extrude: draw a sketch with a closed outline first.'
    );
  });
});
