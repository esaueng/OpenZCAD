import { toProjectId, type ProjectId } from '@openzcad/shared';

/**
 * What the launcher needs to *offer* a demo, separated from what building one
 * costs.
 *
 * The three demo tiles are on screen before any project is open, but the
 * builders behind them are several hundred lines of command construction that
 * reach into the command system and the exact kernel. Keeping both in one
 * module put all of that in the launcher chunk to render three names and three
 * taglines. The catalogue lives here and is imported eagerly; `demos.ts` holds
 * the builders and is imported when a demo is actually opened.
 */

export interface DemoDefinition {
  key: string;
  projectId: ProjectId;
  name: string;
  tagline: string;
  revisions: [string, string, string];
}

export const DEMO_DEFINITIONS: DemoDefinition[] = [
  {
    key: 'bracket',
    projectId: toProjectId('proj_demo_mounting_bracket'),
    name: 'Demo · Mounting Bracket',
    tagline: 'L-bracket with boss and mounting holes',
    revisions: [
      'A — L-bracket blank',
      'B — Boss + holes',
      'C — Edge break fillet'
    ]
  },
  {
    key: 'flange',
    projectId: toProjectId('proj_demo_pipe_flange'),
    name: 'Demo · Pipe Flange',
    tagline: 'Revolved flange with a patterned bolt circle',
    revisions: ['A — Revolved blank', 'B — Bolt circle', 'C — Rim chamfer']
  },
  {
    key: 'heatsink',
    projectId: toProjectId('proj_demo_heat_sink'),
    name: 'Demo · Heat Sink',
    tagline: 'Extruded base with a parametric fin field',
    revisions: ['A — Base extrusion', 'B — Fin field', 'C — Corner fillets']
  }
];

/** E2E-only seeded part with every analytic surface used by visual acceptance. */
export const VISUAL_SELECTION_ACCEPTANCE_DEMO: DemoDefinition = {
  key: 'visual-selection-acceptance',
  projectId: toProjectId('proj_e2e_visual_selection_acceptance'),
  name: 'Demo · Visual Selection Reference',
  tagline: 'Boss with through-bore and a finished rim',
  revisions: ['A — Boss blank', 'B — Through-bore', 'C — Lower rim fillet']
};
