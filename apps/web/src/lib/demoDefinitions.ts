import { toProjectId, type ProjectId } from '@openzcad/shared';

/**
 * What the launcher needs to *offer* a demo, separated from what building one
 * costs.
 *
 * The demo tiles are on screen before any project is open, but the
 * builders behind them are several hundred lines of command construction that
 * reach into the command system and the exact kernel. Keeping both in one
 * module put all of that in the launcher chunk to render names and
 * taglines. The catalogue lives here and is imported eagerly; `demos.ts` holds
 * the builders and is imported when a demo is actually opened.
 */

export interface DemoDefinition {
  key: string;
  projectId: ProjectId;
  name: string;
  tagline: string;
  /** The tagline cut to its operations, for the narrow column list. */
  summary?: string;
  /** Stored design stages; empty for samples supplied as a finished project. */
  revisions: [] | [string, string, string];
  /** Open an assembly example with its first joint ready to try. */
  initialWorkspace?: 'assemble';
  /** A transient demonstration when this assembly example opens. */
  initialPlayback?: 'ping-pong';
}

export const DEMO_DEFINITIONS: DemoDefinition[] = [
  {
    key: 'bracket',
    projectId: toProjectId('proj_demo_mounting_bracket'),
    name: 'Demo · Mounting Bracket',
    tagline: 'L-bracket with boss and mounting holes',
    summary: 'Boss, holes, fillet',
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
    summary: 'Revolve, bolt circle, chamfer',
    revisions: ['A — Revolved blank', 'B — Bolt circle', 'C — Rim chamfer']
  },
  {
    key: 'heatsink',
    projectId: toProjectId('proj_demo_heat_sink'),
    name: 'Demo · Heat Sink',
    tagline: 'Extruded base with a parametric fin field',
    summary: 'Extrude, fin field, fillets',
    revisions: ['A — Base extrusion', 'B — Fin field', 'C — Corner fillets']
  },
  {
    key: 'scissors',
    projectId: toProjectId('proj_demo_scissors'),
    name: 'Demo · Scissors',
    tagline: 'Scissors assembly with a working revolute pivot',
    summary: 'Assembly, revolute pivot',
    revisions: [],
    initialWorkspace: 'assemble',
    initialPlayback: 'ping-pong'
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

const DEMO_NAME_PREFIX = 'Demo · ';
const DEMO_PROJECT_IDS: ReadonlySet<string> = new Set(
  [...DEMO_DEFINITIONS, VISUAL_SELECTION_ACCEPTANCE_DEMO].map(
    (definition) => definition.projectId
  )
);

/**
 * The name a copy of a project starts from. A copy of a sample is the
 * user's own project, so it drops the "Demo · " the sample wears on the
 * shelf: "Mounting Bracket (copy)", not "Demo · Mounting Bracket (copy)".
 */
export function copyBaseName(projectId: string, name: string): string {
  return DEMO_PROJECT_IDS.has(projectId) && name.startsWith(DEMO_NAME_PREFIX)
    ? name.slice(DEMO_NAME_PREFIX.length)
    : name;
}
