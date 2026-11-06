import { campaignCells } from './support/combination-matrix';
import { defineLedgerSuite } from './support/combination-matrix-suite';
import {
  runTwinCell,
  twinCampaignCells,
  twinReproduction
} from './support/imported-twin';

/**
 * K10 full campaign: every generated cell the CI slice does not run, against
 * `combination-matrix.full.ledger.json`, and the imported-twin R-slice
 * against `combination-matrix.imported-twin.full.ledger.json`. Deliberately
 * outside test/unit-ci-files.json; it runs in the full root suite
 * (`pnpm test:unit:full`) and with
 * `pnpm exec vitest run test/combination-matrix.full.test.ts`.
 * `K10_RECORD=1` rewrites the ledgers; see combination-matrix-suite.ts.
 */
defineLedgerSuite(
  'K10 combination matrix: full campaign',
  new URL('./combination-matrix.full.ledger.json', import.meta.url),
  campaignCells()
);

defineLedgerSuite(
  'K10 imported twin: R-slice campaign',
  new URL(
    './combination-matrix.imported-twin.full.ledger.json',
    import.meta.url
  ),
  twinCampaignCells(),
  { run: runTwinCell, reproduction: twinReproduction }
);
