import type { CadPatchProposal } from '@openzcad/ai-contracts';

/**
 * Suggestions are product promises, not generated copy. A verified proposal
 * bypasses the provider and is accepted only through the same exact preflight
 * as every other patch; ordinary prompts remain editable conversation starters.
 */
export interface AssistantSuggestion {
  id: string;
  label: string;
  proposal?: CadPatchProposal;
}

export interface AssistantSuggestionContext {
  bodyCount: number;
  /** The kind every selected topology shares, when they share one. */
  topologyKind: 'body' | 'face' | 'edge' | null;
  selectedBodyCount: number;
}

const dimensions = (
  values: Partial<
    Extract<
      CadPatchProposal['operations'][number],
      { kind: 'add_primitive' }
    >['dimensions']
  >
) => ({
  width: null,
  height: null,
  depth: null,
  radius: null,
  bottomRadius: null,
  topRadius: null,
  majorRadius: null,
  minorRadius: null,
  ...values
});

const plateHolePlacements: ReadonlyArray<
  readonly [localId: string, x: string, y: string]
> = [
  ['hole_a', 'hole_inset', 'hole_inset'],
  ['hole_b', 'plate_length - hole_inset', 'hole_inset'],
  ['hole_c', 'plate_length - hole_inset', 'plate_width - hole_inset'],
  ['hole_d', 'hole_inset', 'plate_width - hole_inset']
];

const plateWithHoles: CadPatchProposal = {
  proposalId: 'verified_plate_four_m4_holes_v1',
  summary:
    'An 80 × 60 × 6 mm plate will be created with four through M4 clearance holes.',
  assumptions: [
    'M4 clearance diameter is 4.5 mm.',
    'Hole centers are inset 10 mm from each adjacent plate edge.',
    'All driving dimensions are editable parameters.'
  ],
  operations: [
    { kind: 'set_parameter', name: 'plate_length', expression: '80' },
    { kind: 'set_parameter', name: 'plate_width', expression: '60' },
    { kind: 'set_parameter', name: 'plate_thickness', expression: '6' },
    { kind: 'set_parameter', name: 'hole_diameter', expression: '4.5' },
    { kind: 'set_parameter', name: 'hole_inset', expression: '10' },
    { kind: 'set_parameter', name: 'cut_overrun', expression: '1' },
    {
      kind: 'add_primitive',
      name: 'Plate Blank',
      localId: 'plate_blank',
      primitiveKind: 'box',
      dimensions: dimensions({
        width: 'plate_length',
        height: 'plate_width',
        depth: 'plate_thickness'
      })
    },
    ...plateHolePlacements.flatMap(([localId, x, y], index) => [
      {
        kind: 'add_primitive' as const,
        name: `M4 Hole ${index + 1}`,
        localId,
        primitiveKind: 'cylinder' as const,
        dimensions: dimensions({
          radius: 'hole_diameter / 2',
          height: 'plate_thickness + 2 * cut_overrun'
        })
      },
      {
        kind: 'add_transform' as const,
        name: `Position M4 Hole ${index + 1}`,
        targetBodyId: `$${localId}`,
        translation: { x, y, z: '-cut_overrun' },
        rotationDeg: { x: 0, y: 0, z: 0 }
      }
    ]),
    {
      kind: 'add_boolean',
      name: 'Plate',
      localId: 'plate',
      operation: 'subtract',
      targetBodyIds: [
        '$plate_blank',
        '$hole_a',
        '$hole_b',
        '$hole_c',
        '$hole_d'
      ]
    }
  ]
};

const roundedCube: CadPatchProposal = {
  proposalId: 'verified_rounded_cube_v1',
  summary: 'A 40 mm cube will be created with 3 mm fillets on every edge.',
  assumptions: [
    'The cube is axis-aligned with one corner at the origin.',
    'Every physical box edge receives the same editable 3 mm radius.'
  ],
  operations: [
    { kind: 'set_parameter', name: 'cube_size', expression: '40' },
    { kind: 'set_parameter', name: 'edge_radius', expression: '3' },
    {
      kind: 'add_primitive',
      name: 'Cube',
      localId: 'cube',
      primitiveKind: 'box',
      dimensions: dimensions({
        width: 'cube_size',
        height: 'cube_size',
        depth: 'cube_size'
      })
    },
    {
      kind: 'add_edge_modifier',
      name: 'Rounded Cube',
      localId: 'rounded_cube',
      modifier: 'fillet',
      targetBodyId: '$cube',
      edgeHashes: [],
      edgeSelector: 'all-feature-edges',
      size: 'edge_radius'
    }
  ]
};

const chamferedShaft: CadPatchProposal = {
  proposalId: 'verified_chamfered_shaft_v1',
  summary:
    'A Ø30 × 60 mm shaft will be created with 1 mm chamfers on both circular ends.',
  assumptions: [
    'The chamfers are equal-distance 1 × 1 mm, 45-degree chamfers.',
    'The stated 60 mm length is the overall end-to-end length after chamfering.',
    'Diameter, overall length, and chamfer size are editable parameters.'
  ],
  operations: [
    { kind: 'set_parameter', name: 'shaft_diameter', expression: '30' },
    { kind: 'set_parameter', name: 'shaft_length', expression: '60' },
    { kind: 'set_parameter', name: 'chamfer_size', expression: '1' },
    {
      kind: 'add_primitive',
      name: 'Shaft Blank',
      localId: 'shaft_blank',
      primitiveKind: 'cylinder',
      dimensions: dimensions({
        radius: 'shaft_diameter / 2',
        height: 'shaft_length'
      })
    },
    {
      kind: 'add_edge_modifier',
      name: 'Chamfered Shaft',
      localId: 'chamfered_shaft',
      modifier: 'chamfer',
      targetBodyId: '$shaft_blank',
      edgeHashes: [],
      edgeSelector: 'circular-rims',
      size: 'chamfer_size'
    }
  ]
};

const prompt = (id: string, label: string): AssistantSuggestion => ({
  id,
  label
});

export function assistantSuggestions(
  context: AssistantSuggestionContext
): AssistantSuggestion[] {
  if (context.topologyKind === 'edge') {
    return [
      prompt('selected-edge-fillet', 'Fillet the selected edges by 2 mm'),
      prompt('selected-edge-chamfer', 'Chamfer the selected edges 1 mm'),
      prompt(
        'selected-edge-explain',
        'What would rounding these edges do to the part?'
      )
    ];
  }
  if (context.topologyKind === 'face') {
    return [
      prompt('selected-face-hole', 'Cut a 6 mm hole through the selected face'),
      prompt('selected-face-offset', 'Offset the selected face out by 3 mm'),
      prompt('selected-face-sketch', 'Sketch a 20 mm slot on the selected face')
    ];
  }
  if (context.selectedBodyCount > 0) {
    return [
      prompt(
        'selected-body-round',
        'Round every outside edge of the selection by 2 mm'
      ),
      prompt(
        'selected-body-pattern',
        'Pattern the selected body 4 times, 30 mm apart along X'
      ),
      prompt(
        'selected-body-parameter',
        'Add a parameter for the wall thickness and drive the selection from it'
      )
    ];
  }
  if (context.bodyCount === 0) {
    return [
      {
        id: 'verified-plate-four-m4-holes',
        label: 'Model an 80 × 60 × 6 mm plate with four M4 clearance holes',
        proposal: plateWithHoles
      },
      {
        id: 'verified-rounded-cube',
        label: 'Build a 40 mm cube with 3 mm rounded edges',
        proposal: roundedCube
      },
      {
        id: 'verified-chamfered-shaft',
        label: 'Make a Ø30 × 60 mm shaft with a 1 mm chamfer on both ends',
        proposal: chamferedShaft
      }
    ];
  }
  return [
    prompt('all-edges-round', 'Round every outside edge by 2 mm'),
    prompt('tallest-body-bore', 'Cut a 12 mm bore through the tallest body'),
    prompt(
      'feature-history-explain',
      'What is this model made of, feature by feature?'
    )
  ];
}
