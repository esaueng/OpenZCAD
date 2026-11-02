/** Known Remus deviations from corpus construction arithmetic. */
export interface ReferenceDeviationPin {
  subject: string;
  kernel: 'remus';
  referenceMm3: number;
  reported: number | 'refused' | 'threw';
  owner: 'K0.1';
  note: string;
}

export const REFERENCE_DEVIATIONS: ReferenceDeviationPin[] = [
  {
    subject: 'b-unit-no-global-context',
    kernel: 'remus',
    referenceMm3: 20 * 20 * 20,
    reported: 'refused',
    owner: 'K0.1',
    note:
      'A 20 mm cube whose units are declared and never bound to a ' +
      "GLOBAL_UNIT_ASSIGNED_CONTEXT. K0.1's unit work made Remus refuse " +
      'it rather than assume millimetres. Fails closed, which is the safe ' +
      'direction — a wrong scale is silent and expensive — but the file is ' +
      'geometrically a cube, so this remains a reader capability ' +
      'gap unless K0.1 either imports it with a stated assumption ' +
      'or surfaces the refusal before the user commits.'
  },
  {
    subject: 'e-nurbs-fillet-plate',
    kernel: 'remus',
    referenceMm3: 40 * 24 * 10 - 4 * (1 - Math.PI / 4) * 9 * 10,
    reported: 9539.18785770401,
    owner: 'K0.1',
    note:
      'Reads 0.17% over the closed-form INTENT because the FILE is 0.181% ' +
      'over it: the corner bands are non-rational quadratic B-splines ' +
      '(parabolas), and the file content is exactly 9540.0 mm³. Remus is ' +
      'FAITHFUL to the file, and the B20 exact-measurement pin (2.130.23, ' +
      'remus #457) brought the read from 9537.866 to 9539.116, and Remus ' +
      '2026.1.69 to 9539.188 — the ' +
      'residue vs 9540 is the ordinary inscribed undercount, now smaller. ' +
      'Resolved by remus PR #62; the pin stays because the corpus compares ' +
      'against the design intent, which no honest reader of this file can ' +
      'hit. The original measurements remain in Git history.'
  }
];

export function findReferenceDeviation(
  subject: string,
  kernel: 'remus'
): ReferenceDeviationPin | undefined {
  return REFERENCE_DEVIATIONS.find(
    (pin) => pin.subject === subject && pin.kernel === kernel
  );
}
