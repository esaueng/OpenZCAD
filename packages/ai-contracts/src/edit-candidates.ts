import {
  isValidParameterName,
  listFeaturesInOrder,
  listParameters
} from '@openzcad/document-core';
import type {
  BodyId,
  EditAnalysisRequest,
  ProjectDocument
} from '@openzcad/shared';
import { createAutoParameterizeProposal } from './auto-parameterize';
import { createGrowingHolderProposal } from './growing-holder-proposal';
import type {
  CadPatchOperation,
  CadPatchProposal,
  CadSelectionContext
} from './index';

export interface EditCandidate {
  id: string;
  bodyId: string;
  label: string;
  parameters: Array<{ key: string; value: string }>;
  /** These are qualified command families; every proposal still needs preflight. */
  status: 'preview-required';
  description: string;
  analysis: EditAnalysisRequest | null;
}

export interface MeasuredEditValue {
  bodyId: string;
  label: string;
  value: number;
  unit: string;
  reason: string;
}

export interface EditCandidateCatalog {
  candidates: EditCandidate[];
  measuredOnly: MeasuredEditValue[];
  complete: boolean;
}

interface CandidateRecipe {
  candidate: EditCandidate;
  proposal: CadPatchProposal;
}

const MAX_CANDIDATES = 30;

export function unmodifiedImportedSource(
  document: ProjectDocument,
  bodyId: string
) {
  const features = listFeaturesInOrder(document);
  const index = features.findIndex(
    (feature) =>
      feature.bodyId === bodyId && feature.data.featureKind === 'imported-step'
  );
  const source = features[index];
  if (
    !source ||
    source.data.featureKind !== 'imported-step' ||
    source.data.planarEmboss ||
    features
      .slice(index + 1)
      .some(
        (feature) =>
          ('targetBodyId' in feature.data &&
            feature.data.targetBodyId === bodyId) ||
          ('targetBodyIds' in feature.data &&
            feature.data.targetBodyIds.includes(bodyId as BodyId))
      )
  )
    return null;
  return source;
}

/** A selector, not a topology authority: recipes are regenerated at compilation
 * and their exact references are checked again by geometry preflight. */
function recipeId(
  document: ProjectDocument,
  bodyId: string,
  proposal: CadPatchProposal
): string {
  let first = 2166136261;
  let second = 5381;
  for (const char of JSON.stringify(proposal.operations)) {
    first = Math.imul(first ^ char.charCodeAt(0), 16777619);
    second = Math.imul(second, 33) ^ char.charCodeAt(0);
  }
  return `edit:${document.projectId}:${document.version}:${bodyId}:${first >>> 0}:${second >>> 0}`;
}

function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object') return [];
  return Object.values(value).flatMap(stringsIn);
}

function recipesForBody(
  document: ProjectDocument,
  bodyId: string
): CandidateRecipe[] {
  const analysis =
    document.derived.editAnalysis?.bodyId === bodyId
      ? document.derived.editAnalysis
      : undefined;
  const selection: CadSelectionContext = {
    bodyIds: [bodyId],
    featureIds: [],
    topologies: (analysis?.faceHashes ?? []).map((hash) => ({
      bodyId: bodyId as BodyId,
      kind: 'face',
      hash,
      topologyId: `face:${hash}`
    }))
  };
  const automatic = createAutoParameterizeProposal(document, selection);
  const parameters =
    automatic?.operations.filter((op) => op.kind === 'set_parameter') ?? [];
  const proposals: CadPatchProposal[] = (automatic?.operations ?? [])
    .filter((op) => op.kind !== 'set_parameter')
    .map((operation) => {
      const references = new Set(stringsIn(operation));
      const declarations = parameters.filter((parameter) =>
        references.has(parameter.name)
      );
      return {
        proposalId: 'measured-dimension',
        summary: `${declarations.map((parameter) => parameter.name).join(', ')} will become editable without changing the initial geometry.`,
        assumptions: [
          'Only the measured dimension is bound. Related dimensions are not coupled automatically.'
        ],
        operations: [...declarations, operation],
        preserveGeometry: true
      };
    });
  const opening = createGrowingHolderProposal(document, selection);
  const source = unmodifiedImportedSource(document, bodyId);
  if (opening && source) proposals.unshift(opening);
  const emboss =
    document.derived.bodyRepresentations[
      bodyId as keyof typeof document.derived.bodyRepresentations
    ]?.topology?.recognizedPlanarEmboss;
  const existingNames = new Set(
    listParameters(document).map((parameter) => parameter.name)
  );
  let detailsParameter = 'show_details';
  for (let suffix = 2; existingNames.has(detailsParameter); suffix++)
    detailsParameter = `show_details_${suffix}`;
  if (emboss && source)
    proposals.unshift({
      proposalId: 'raised-feature-control',
      summary: `The measured raised profiles will become a separate body with a ${detailsParameter} visibility control, including STEP exports. The supporting part stays unchanged apart from separating those profiles.`,
      assumptions: [
        'The preview identifies the raised group geometrically; it does not read text or infer a logo.'
      ],
      operations: [
        {
          kind: 'add_raised_feature_control',
          targetBodyId: bodyId,
          parameter: detailsParameter,
          selection: emboss
        }
      ]
    });
  return proposals.map((proposal) => {
    const openingOp = proposal.operations.find(
      (op) => op.kind === 'add_growing_holder_recipe'
    );
    const raisedOp = proposal.operations.find(
      (op) => op.kind === 'add_raised_feature_control'
    );
    const values =
      openingOp?.kind === 'add_growing_holder_recipe'
        ? [
            {
              key: openingOp.parameter,
              value: String(openingOp.opening.sourceOpening)
            },
            ...(openingOp.opening.height && openingOp.heightParameter
              ? [
                  {
                    key: openingOp.heightParameter,
                    value: String(openingOp.opening.height.sourceHeight)
                  }
                ]
              : [])
          ]
        : raisedOp?.kind === 'add_raised_feature_control'
          ? [{ key: raisedOp.parameter, value: '1' }]
          : proposal.operations.flatMap((op) =>
              op.kind === 'set_parameter'
                ? [{ key: op.name, value: op.expression }]
                : []
            );
    const bodyName =
      document.derived.bodyRepresentations[
        bodyId as keyof typeof document.derived.bodyRepresentations
      ]?.name ?? bodyId;
    return {
      proposal,
      candidate: {
        id: recipeId(document, bodyId, proposal),
        bodyId,
        label: raisedOp
          ? `${bodyName}: raised-feature visibility`
          : openingOp
            ? `${bodyName}: opening`
            : values.map((value) => value.key).join(', '),
        parameters: values,
        status: 'preview-required',
        description: proposal.summary,
        analysis:
          document.derived.editAnalysis?.bodyId === bodyId
            ? document.derived.editAnalysis
            : null
      }
    };
  });
}

export function createEditCandidateCatalog(
  document: ProjectDocument,
  selection: CadSelectionContext
): EditCandidateCatalog {
  const selected = new Set([
    ...selection.bodyIds,
    ...selection.topologies.map((item) => item.bodyId)
  ]);
  const bodies = document.bodyOrder.filter((bodyId) => {
    const body = document.derived.bodyRepresentations[bodyId];
    return (
      body && !body.consumed && (selected.size === 0 || selected.has(bodyId))
    );
  });
  const boundedBodies = bodies.slice(0, MAX_CANDIDATES);
  const all = boundedBodies.flatMap((bodyId) =>
    recipesForBody(document, bodyId).map((recipe) => recipe.candidate)
  );
  const measuredOnly: MeasuredEditValue[] = boundedBodies
    .flatMap((bodyId) =>
      (
        document.derived.bodyRepresentations[bodyId]?.topology
          ?.recognizedImportedFeatures ?? []
      ).flatMap((feature) => {
        const base = { bodyId: String(bodyId), unit: document.units };
        if (feature.kind === 'blind-cylindrical-hole')
          return [
            {
              ...base,
              label: 'Hole depth',
              value: feature.depth,
              reason:
                'Depth editing is not supported; diameter editing is available.'
            }
          ];
        if (feature.kind === 'counterbore')
          return [
            {
              ...base,
              label: 'Counterbore depth',
              value: feature.counterboreDepth,
              reason: feature.entryChamfered
                ? 'This chamfered-entry hole is measured only; resizing is not supported.'
                : 'Depth editing is not supported; diameter editing is available.'
            }
          ];
        if (feature.kind === 'countersink')
          return [
            {
              ...base,
              label: 'Countersink angle',
              unit: 'rad',
              value: feature.angleRadians,
              reason:
                'Angle editing is not supported; diameter editing is available.'
            }
          ];
        return [];
      })
    )
    .slice(0, MAX_CANDIDATES);
  return {
    candidates: all.slice(0, MAX_CANDIDATES),
    measuredOnly,
    complete:
      all.length < MAX_CANDIDATES &&
      bodies.length <= MAX_CANDIDATES &&
      bodies.every(
        (id) => (document.derived.bodyRepresentations[id]?.faceCount ?? 0) <= 64
      )
  };
}

/** The button and natural-language action use this same, bounded operation. */
export function proposalForEditCandidate(
  candidate: EditCandidate
): CadPatchProposal {
  return {
    proposalId: candidate.id,
    summary: candidate.description,
    assumptions: [
      'Review the measured target and exact preview before applying.'
    ],
    operations: [
      {
        kind: 'use_edit_candidate',
        candidateId: candidate.id,
        targetBodyId: candidate.bodyId,
        parameterNames: [],
        analysis: candidate.analysis
      }
    ]
  };
}

function renameBinding(
  operation: CadPatchOperation,
  names: Map<string, string>
): CadPatchOperation {
  const copy = structuredClone(operation);
  if (copy.kind === 'add_raised_feature_control')
    copy.parameter = names.get(copy.parameter) ?? copy.parameter;
  if (copy.kind === 'set_parameter')
    copy.name = names.get(copy.name) ?? copy.name;
  if (
    copy.kind === 'set_feature_dimension' ||
    copy.kind === 'set_sketch_dimension'
  ) {
    if (typeof copy.value === 'string')
      copy.value = names.get(copy.value) ?? copy.value;
  }
  if (copy.kind === 'add_direct_edit') {
    // Replace only the exact parameter-valued fields, never identifiers or witnesses.
    const edit = copy.operation;
    for (const field of [
      'diameter',
      'boreDiameter',
      'counterboreDiameter',
      'sinkDiameter',
      'distance',
      'newRadius'
    ] as const) {
      if (field in edit) {
        const record = edit as unknown as Record<string, unknown>;
        const value = record[field];
        if (typeof value === 'string' && names.has(value))
          record[field] = names.get(value)!;
      }
    }
  }
  if (copy.kind === 'add_growing_holder_recipe') {
    copy.parameter = names.get(copy.parameter) ?? copy.parameter;
    if (copy.heightParameter)
      copy.heightParameter =
        names.get(copy.heightParameter) ?? copy.heightParameter;
  }
  return copy;
}

export function expandEditCandidateProposal(
  document: ProjectDocument,
  proposal: CadPatchProposal
): CadPatchProposal {
  if (!proposal.operations.some((op) => op.kind === 'use_edit_candidate'))
    return proposal;
  // Mixing arbitrary mutations and bindings invalidates the measured snapshot.
  if (proposal.operations.some((op) => op.kind !== 'use_edit_candidate'))
    throw new Error(
      'Apply measured parameter bindings separately from other edits.'
    );
  const used = new Set(
    listParameters(document).map((parameter) => parameter.name)
  );
  const selected = new Set<string>();
  const recipes: CadPatchProposal[] = [];
  for (const operation of proposal.operations) {
    if (operation.kind !== 'use_edit_candidate') continue;
    if (selected.has(operation.candidateId))
      throw new Error('The same edit candidate was selected twice.');
    selected.add(operation.candidateId);
    const recipe = recipesForBody(document, operation.targetBodyId).find(
      (item) => item.candidate.id === operation.candidateId
    );
    if (!recipe)
      throw new Error(
        'This measured edit is stale or unavailable. Refresh the part analysis and try again.'
      );
    const names = new Map<string, string>();
    for (const rename of operation.parameterNames) {
      if (
        names.has(rename.key) ||
        !recipe.candidate.parameters.some(
          (parameter) => parameter.key === rename.key
        ) ||
        !isValidParameterName(rename.name)
      )
        throw new Error('Invalid measured parameter name.');
      names.set(rename.key, rename.name);
    }
    for (const parameter of recipe.candidate.parameters) {
      const name = names.get(parameter.key) ?? parameter.key;
      if (used.has(name))
        throw new Error(
          `Parameter ${name} already exists. Choose a different name.`
        );
      used.add(name);
    }
    recipes.push({
      ...recipe.proposal,
      operations: recipe.proposal.operations.map((op) =>
        renameBinding(op, names)
      )
    });
  }
  const operations = recipes.flatMap((recipe) => recipe.operations);
  if (operations.length > 60)
    throw new Error('Select fewer dimensions for one proposal.');
  return {
    ...proposal,
    assumptions: recipes.flatMap((recipe) => recipe.assumptions),
    operations,
    preserveGeometry: recipes.every(
      (recipe) => recipe.preserveGeometry === true
    )
  };
}
