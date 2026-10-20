import { readFileSync } from 'node:fs';

/**
 * The fleet workflow `ci.yml` runs, at a commit main already contains. A
 * change lands as a new versioned `fleet-ci-vN.yml` first and goes live when
 * a later PR re-pins to it (docs/runner-routing.md), so the active file is
 * whichever one the pin names.
 */
const caller = readFileSync('.github/workflows/ci.yml', 'utf8');
const pin =
  /uses: esaueng\/OpenZCAD\/\.github\/workflows\/(fleet-ci(?:-v\d+)?\.yml)@([0-9a-f]{40})\n/.exec(
    caller
  );
if (!pin) {
  throw new Error('ci.yml must pin a fleet-ci workflow to a full commit SHA');
}

export const FLEET_CI_PATH = `.github/workflows/${pin[1]}`;
export const FLEET_CI_PIN = pin[2];
