import { expect, it } from 'vitest';
import { combineStepRoots } from './step';
it('remaps independent roots without modifying quoted metadata or geometry', () => {
  const root = (id: number) =>
    `ISO-10303-21;\nHEADER;\nFILE_NAME('x');\nENDSEC;\nDATA;\n#${id} = CARTESIAN_POINT('quote '' #10',(1.25,2.,3.));\n#${id + 1} = VERTEX_POINT('',#${id});\n/* #999 is a comment */\nENDSEC;\nEND-ISO-10303-21;`;
  expect(combineStepRoots([root(1), root(1)])).toContain(
    "#3 = CARTESIAN_POINT('quote '' #10',(1.25,2.,3.));"
  );
  expect(combineStepRoots([root(1), root(1)])).toContain(
    "#4 = VERTEX_POINT('',#3);"
  );
  expect(() => combineStepRoots([])).toThrow();
});
