import { campaignCells } from './support/combination-matrix';
import { defineLedgerSuite } from './support/combination-matrix-suite';

/**
 * K10 full campaign: every generated cell the CI slice does not run, against
 * `combination-matrix.full.ledger.json`. Deliberately outside
 * test/unit-ci-files.json; it runs in the full root suite
 * (`pnpm test:unit:full`) and with
 * `pnpm exec vitest run test/combination-matrix.full.test.ts`.
 * `K10_RECORD=1` rewrites the ledger; see combination-matrix-suite.ts.
 */
defineLedgerSuite(
  'K10 combination matrix: full campaign',
  new URL('./combination-matrix.full.ledger.json', import.meta.url),
  campaignCells()
);
