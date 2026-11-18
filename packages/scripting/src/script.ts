import {
  evaluateFieldExpression,
  parameterKindsOf,
  withParameterKinds
} from '@openzcad/document-core';
import type {
  CustomFeatureScript,
  EdgeWitnessV1,
  FaceWitnessV1,
  ParameterKind,
  ParamValue,
  QuantizedTopologyPoint,
  UnitSystem
} from '@openzcad/shared';
import {
  HistoryTextSyntaxError,
  parseScriptText,
  type HistoryTextDiagnostic,
  type QueryCall,
  type RecordNode,
  type TextSpan,
  type ValueNode
} from './syntax';

/**
 * L15 custom-feature scripts, `api 1`.
 *
 * A script is data, never code: this module parses it, checks it, and
 * interprets it step by step. There is no `eval`, no `Function`, no import,
 * no I/O and no loop; a script is a bounded list of steps over picks that
 * are exact queries on the body's topology. It runs wherever the exact build
 * runs (the kernel worker), and every pick must find exactly the number of
 * entities it declares or the whole feature refuses.
 */

/** The scripting contract this release reads. */
export const SCRIPT_API_VERSION = 1;
export const MAX_SCRIPT_STEPS = 60;
export const MAX_SCRIPT_PICKS = 60;
export const MAX_SCRIPT_INPUTS = 30;
export const MAX_SCRIPT_SOURCE_BYTES = 64 * 1024;

/** The ADR-011 length quantum witnesses are measured in. */
const LENGTH_QUANTUM = 1e-6;

export type ScriptInputQuantity = ParameterKind | 'count';

export interface ScriptInput {
  name: string;
  quantity: ScriptInputQuantity;
  defaultValue: ParamValue | null;
}

export type ScriptAxis = 0 | 1 | 2;

export type ScriptFilter =
  | { kind: 'type'; value: string }
  | { kind: 'normal'; axis: ScriptAxis }
  | { kind: 'axis'; axis: ScriptAxis }
  | { kind: 'radius'; value: ParamValue }
  | { kind: 'extreme'; axis: ScriptAxis; max: boolean };

export interface ScriptPick {
  name: string;
  entity: 'face' | 'edge';
  count: number;
  filters: ScriptFilter[];
}

export type ScriptStepKind = 'fillet' | 'chamfer' | 'shell';

export interface ScriptStep {
  kind: ScriptStepKind;
  pick: string;
  size: ParamValue;
}

/** A checked script, ready to run. */
export interface CompiledScript {
  id: string;
  version: string;
  api: 1;
  inputs: ScriptInput[];
  picks: Map<string, ScriptPick>;
  steps: ScriptStep[];
}

export interface ScriptCompileResult {
  script: CompiledScript | null;
  diagnostics: HistoryTextDiagnostic[];
}

const QUANTITIES: Record<ScriptInputQuantity, true> = {
  length: true,
  angle: true,
  number: true,
  count: true
};

/** Each step's pick field, the entity it takes, and its size field. */
const STEP_FIELDS: Record<
  ScriptStepKind,
  { pick: string; entity: 'face' | 'edge'; size: string }
> = {
  fillet: { pick: 'edges', entity: 'edge', size: 'radius' },
  chamfer: { pick: 'edges', entity: 'edge', size: 'distance' },
  shell: { pick: 'faces', entity: 'face', size: 'thickness' }
};

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ID = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)+$/;
const VERSION = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;

class ScriptChecker {
  readonly diagnostics: HistoryTextDiagnostic[] = [];
  /** Picks already refused: a step using one is not refused again for it. */
  readonly failedPicks = new Set<string>();

  error(message: string, span: TextSpan): void {
    this.diagnostics.push({ severity: 'error', message, span });
  }

  axis(call: QueryCall): ScriptAxis | null {
    const [arg] = call.args;
    if (
      call.args.length !== 1 ||
      arg!.type !== 'string' ||
      !['x', 'y', 'z'].includes(arg.value)
    ) {
      this.error(
        `\`${call.name}\` takes one axis: "x", "y" or "z".`,
        call.span
      );
      return null;
    }
    return ['x', 'y', 'z'].indexOf(arg.value) as ScriptAxis;
  }

  scalar(node: ValueNode, what: string): ParamValue | null {
    if (node.type === 'number' || node.type === 'expression') return node.value;
    this.error(
      `${what} takes a number or an expression in backticks.`,
      node.span
    );
    return null;
  }

  filter(call: QueryCall, entity: 'face' | 'edge'): ScriptFilter | null {
    switch (call.name) {
      case 'type': {
        const [arg] = call.args;
        if (call.args.length !== 1 || arg!.type !== 'string') {
          this.error(
            '`type` takes one quoted kind, such as "plane" or "line".',
            call.span
          );
          return null;
        }
        // Kinds compare in lower case: the kernel names curves "LINE" and
        // surfaces "plane"; a script writes "line" and "plane".
        return { kind: 'type', value: arg.value.toLowerCase() };
      }
      case 'normal': {
        if (entity !== 'face') {
          this.error(
            '`normal` filters faces; an edge has an `axis`.',
            call.span
          );
          return null;
        }
        const axis = this.axis(call);
        return axis === null ? null : { kind: 'normal', axis };
      }
      case 'axis': {
        const axis = this.axis(call);
        return axis === null ? null : { kind: 'axis', axis };
      }
      case 'radius': {
        if (entity !== 'face') {
          this.error(
            '`radius` filters cylindrical faces; pick an edge by its face or position.',
            call.span
          );
          return null;
        }
        if (call.args.length !== 1) {
          this.error('`radius` takes one length.', call.span);
          return null;
        }
        const value = this.scalar(call.args[0]!, '`radius`');
        return value === null ? null : { kind: 'radius', value };
      }
      case 'max':
      case 'min': {
        const axis = this.axis(call);
        return axis === null
          ? null
          : { kind: 'extreme', axis, max: call.name === 'max' };
      }
      default:
        this.error(
          `\`${call.name}\` is not a query filter; use type, normal, axis, radius, max or min.`,
          call.span
        );
        return null;
    }
  }

  step(
    kind: ScriptStepKind,
    body: RecordNode,
    picks: Map<string, ScriptPick>
  ): ScriptStep | null {
    const fields = STEP_FIELDS[kind];
    let pick: string | null = null;
    let size: ParamValue | null = null;
    const before = this.diagnostics.length;
    let reported = false;
    for (const entry of body.entries) {
      if (entry.key === fields.pick) {
        if (entry.value.type !== 'id') {
          this.error(
            `\`${fields.pick}\` names a pick, as #name.`,
            entry.value.span
          );
          continue;
        }
        const declared = picks.get(entry.value.value);
        if (!declared && this.failedPicks.has(entry.value.value)) {
          reported = true;
          continue;
        }
        if (!declared) {
          this.error(
            `#${entry.value.value} is not a pick declared above this step.`,
            entry.value.span
          );
          continue;
        }
        if (declared.entity !== fields.entity) {
          this.error(
            `A ${kind} takes ${fields.entity}s; #${declared.name} picks ${declared.entity}s.`,
            entry.value.span
          );
          continue;
        }
        pick = declared.name;
      } else if (entry.key === fields.size) {
        size = this.scalar(entry.value, `\`${fields.size}\``);
      } else {
        this.error(
          `A ${kind} step takes \`${fields.pick}\` and \`${fields.size}\`, not \`${entry.key}\`.`,
          entry.keySpan
        );
      }
    }
    if (pick === null || size === null) {
      if (this.diagnostics.length === before && !reported) {
        this.error(
          `A ${kind} step needs \`${fields.pick}\` and \`${fields.size}\`.`,
          body.span
        );
      }
      return null;
    }
    return { kind, pick, size };
  }
}

/**
 * Parses and checks a script's source. Never throws on bad source: every
 * problem is a diagnostic at its line and column.
 */
export function compileScript(source: string): ScriptCompileResult {
  const checker = new ScriptChecker();
  const start = { line: 1, column: 1, offset: 0 };
  if (new TextEncoder().encode(source).length > MAX_SCRIPT_SOURCE_BYTES) {
    checker.error(
      `A script is at most ${MAX_SCRIPT_SOURCE_BYTES / 1024} KiB.`,
      { start, end: start }
    );
    return { script: null, diagnostics: checker.diagnostics };
  }
  let tree;
  try {
    tree = parseScriptText(source);
  } catch (error) {
    if (error instanceof HistoryTextSyntaxError) {
      return { script: null, diagnostics: [error.diagnostic] };
    }
    throw error;
  }
  if (!ID.test(tree.id)) {
    checker.error(
      'A script id is lower-case and namespaced, such as "acme/mounting-boss".',
      tree.idSpan
    );
  }
  if (!VERSION.test(tree.version)) {
    checker.error(
      'A script version is major.minor.patch, such as "1.0.0".',
      tree.versionSpan
    );
  }
  if (tree.api !== SCRIPT_API_VERSION) {
    checker.error(
      `This script is written for api ${tree.api}; this release runs api ${SCRIPT_API_VERSION}.`,
      tree.apiSpan
    );
  }
  const names = new Set<string>();
  const inputs: ScriptInput[] = [];
  const picks = new Map<string, ScriptPick>();
  const steps: ScriptStep[] = [];
  const usedPicks = new Set<string>();
  for (const item of tree.items) {
    if (item.type !== 'step') {
      if (!NAME.test(item.name)) {
        checker.error(
          `\`${item.name}\` is not a name; use letters, digits and _.`,
          item.span
        );
        continue;
      }
      if (names.has(item.name)) {
        checker.error(`\`${item.name}\` is declared twice.`, item.span);
        continue;
      }
      names.add(item.name);
    }
    if (item.type === 'input') {
      if (!Object.hasOwn(QUANTITIES, item.quantity)) {
        checker.error(
          `\`${item.quantity}\` is not an input quantity; use length, angle, number or count.`,
          item.quantitySpan
        );
        continue;
      }
      const defaultValue =
        item.defaultValue === null
          ? null
          : checker.scalar(item.defaultValue, 'A default');
      inputs.push({
        name: item.name,
        quantity: item.quantity as ScriptInputQuantity,
        defaultValue
      });
    } else if (item.type === 'pick') {
      // Counted as refused until it compiles, so its uses are not reported too.
      checker.failedPicks.add(item.name);
      const entity =
        item.entity === 'face' || item.entity === 'faces'
          ? 'face'
          : item.entity === 'edge' || item.entity === 'edges'
            ? 'edge'
            : null;
      if (!entity) {
        checker.error(
          'A pick takes `face`, `faces`, `edge` or `edges`.',
          item.entitySpan
        );
        continue;
      }
      const plural = item.entity.endsWith('s');
      if (plural && item.count === null) {
        checker.error(
          `Say how many ${entity}s #${item.name} picks, such as \`${item.entity} 4\`; a pick finds exactly that many or refuses.`,
          item.entitySpan
        );
        continue;
      }
      if (!plural && item.count !== null && item.count !== 1) {
        checker.error(
          `\`${item.entity}\` picks one; write \`${entity}s ${item.count}\`.`,
          item.entitySpan
        );
        continue;
      }
      const source = item.query.source;
      if (source.name !== `${entity}s` || source.args.length > 0) {
        checker.error(
          `A ${entity} pick starts from \`${entity}s()\`.`,
          source.span
        );
        continue;
      }
      const filters: ScriptFilter[] = [];
      let ok = true;
      for (const call of item.query.filters) {
        const filter = checker.filter(call, entity);
        if (filter) filters.push(filter);
        else ok = false;
      }
      if (!ok) continue;
      checker.failedPicks.delete(item.name);
      picks.set(item.name, {
        name: item.name,
        entity,
        count: item.count ?? 1,
        filters
      });
    } else {
      if (!Object.hasOwn(STEP_FIELDS, item.kind)) {
        checker.error(
          `\`${item.kind}\` is not a script step; api 1 runs fillet, chamfer and shell.`,
          item.kindSpan
        );
        continue;
      }
      const step = checker.step(item.kind as ScriptStepKind, item.body, picks);
      if (step) {
        steps.push(step);
        usedPicks.add(step.pick);
      }
    }
  }
  if (inputs.length > MAX_SCRIPT_INPUTS) {
    checker.error(
      `A script has at most ${MAX_SCRIPT_INPUTS} inputs.`,
      tree.idSpan
    );
  }
  if (picks.size > MAX_SCRIPT_PICKS) {
    checker.error(
      `A script has at most ${MAX_SCRIPT_PICKS} picks.`,
      tree.idSpan
    );
  }
  if (steps.length > MAX_SCRIPT_STEPS) {
    checker.error(
      `A script has at most ${MAX_SCRIPT_STEPS} steps.`,
      tree.idSpan
    );
  }
  if (steps.length === 0 && checker.diagnostics.length === 0) {
    checker.error('A script needs at least one step.', tree.idSpan);
  }
  for (const item of tree.items) {
    if (
      item.type === 'pick' &&
      picks.has(item.name) &&
      !usedPicks.has(item.name)
    ) {
      checker.diagnostics.push({
        severity: 'warning',
        message: `#${item.name} is never used by a step.`,
        span: item.span
      });
    }
  }
  if (
    checker.diagnostics.some((diagnostic) => diagnostic.severity === 'error')
  ) {
    return { script: null, diagnostics: checker.diagnostics };
  }
  return {
    script: {
      id: tree.id,
      version: tree.version,
      api: 1,
      inputs,
      picks,
      steps
    },
    diagnostics: checker.diagnostics
  };
}

// --- SHA-256 ---------------------------------------------------------------

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

/**
 * SHA-256 of `text` as UTF-8, lower-case hex. Synchronous, so the exact
 * build can check a script's pin where it runs it.
 */
export function sha256Hex(text: string): string {
  const message = new TextEncoder().encode(text);
  const length = message.length;
  const blocks = Math.ceil((length + 9) / 64);
  const padded = new Uint8Array(blocks * 64);
  padded.set(message);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor((length * 8) / 2 ** 32));
  view.setUint32(padded.length - 4, (length * 8) >>> 0);
  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19
  ]);
  const w = new Uint32Array(64);
  const rotr = (value: number, bits: number) =>
    (value >>> bits) | (value << (32 - bits));
  for (let block = 0; block < blocks; block += 1) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(block * 64 + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const s0 =
        rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash as unknown as number[];
    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr(e!, 6) ^ rotr(e!, 11) ^ rotr(e!, 25);
      const ch = (e! & f!) ^ (~e! & g!);
      const t1 = (h! + S1 + ch + K[i]! + w[i]!) >>> 0;
      const S0 = rotr(a!, 2) ^ rotr(a!, 13) ^ rotr(a!, 22);
      const maj = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const t2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d! + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    hash[0] = (hash[0]! + a!) >>> 0;
    hash[1] = (hash[1]! + b!) >>> 0;
    hash[2] = (hash[2]! + c!) >>> 0;
    hash[3] = (hash[3]! + d!) >>> 0;
    hash[4] = (hash[4]! + e!) >>> 0;
    hash[5] = (hash[5]! + f!) >>> 0;
    hash[6] = (hash[6]! + g!) >>> 0;
    hash[7] = (hash[7]! + h!) >>> 0;
  }
  return Array.from(hash, (word) => word.toString(16).padStart(8, '0')).join(
    ''
  );
}

// --- Pinning ---------------------------------------------------------------

/**
 * Why an embedded script cannot run as stored, or null: its source must
 * compile, name the id and version it is stored under, and hash to its pin.
 */
export function customFeatureScriptError(
  script: CustomFeatureScript
): string | null {
  if (sha256Hex(script.source) !== script.digest) {
    return `Script ${script.id} ${script.version} does not match its pinned digest; it was changed after it was published.`;
  }
  const compiled = compileScript(script.source);
  if (!compiled.script) {
    const first = compiled.diagnostics.find(
      (diagnostic) => diagnostic.severity === 'error'
    );
    return `Script ${script.id} ${script.version} does not compile: ${first ? `${first.span.start.line}:${first.span.start.column} ${first.message}` : 'unknown error'}`;
  }
  if (
    compiled.script.id !== script.id ||
    compiled.script.version !== script.version
  ) {
    return `Script source says ${compiled.script.id} ${compiled.script.version}, but it is stored as ${script.id} ${script.version}.`;
  }
  // A stored document is untrusted: its `api` may be anything.
  const api: unknown = script.api;
  if (api !== SCRIPT_API_VERSION) {
    return `Script ${script.id} ${script.version} is written for api ${String(api)}; this release runs api ${SCRIPT_API_VERSION}.`;
  }
  return null;
}

/** Publishes `source` as an embedded script, computing its pin. */
export function publishScript(source: string): {
  script: CustomFeatureScript | null;
  diagnostics: HistoryTextDiagnostic[];
} {
  const compiled = compileScript(source);
  if (!compiled.script)
    return { script: null, diagnostics: compiled.diagnostics };
  return {
    script: {
      id: compiled.script.id,
      version: compiled.script.version,
      api: 1,
      source,
      digest: sha256Hex(source)
    },
    diagnostics: compiled.diagnostics
  };
}

// --- Queries ---------------------------------------------------------------

export interface TopologyFaceEntity {
  hash: number;
  witness: FaceWitnessV1;
}

export interface TopologyEdgeEntity {
  hash: number;
  witness: EdgeWitnessV1;
}

export interface TopologyView {
  faces: readonly TopologyFaceEntity[];
  edges: readonly TopologyEdgeEntity[];
}

/** Zero on the other two axes, in the quantum: exactly parallel. */
function alongAxis(
  direction: QuantizedTopologyPoint | null | undefined,
  axis: ScriptAxis
): boolean {
  if (!direction) return false;
  return direction.every((value, index) =>
    index === axis ? value !== 0 : value === 0
  );
}

function entityPoint(
  entity: TopologyFaceEntity | TopologyEdgeEntity,
  isFace: boolean
): QuantizedTopologyPoint | null {
  if (isFace) return (entity.witness as FaceWitnessV1).centroid;
  const witness = entity.witness as EdgeWitnessV1;
  return witness.closed ? witness.center : witness.midpoint;
}

function matches(
  entity: TopologyFaceEntity | TopologyEdgeEntity,
  isFace: boolean,
  filter: ScriptFilter,
  radius: (value: ParamValue) => number
): boolean {
  if (isFace) {
    const witness = entity.witness as FaceWitnessV1;
    switch (filter.kind) {
      case 'type':
        return witness.surfaceType.toLowerCase() === filter.value;
      case 'normal':
        return (
          witness.analytic.kind === 'plane' &&
          alongAxis(witness.analytic.normal, filter.axis)
        );
      case 'axis':
        return (
          witness.analytic.kind === 'cylinder' &&
          alongAxis(witness.analytic.axis, filter.axis)
        );
      case 'radius':
        return (
          witness.analytic.kind === 'cylinder' &&
          witness.analytic.radius ===
            Math.round(radius(filter.value) / LENGTH_QUANTUM)
        );
      default:
        return true;
    }
  }
  const witness = entity.witness as EdgeWitnessV1;
  switch (filter.kind) {
    case 'type':
      return witness.curveType.toLowerCase() === filter.value;
    case 'axis':
      if (witness.closed) return alongAxis(witness.axis, filter.axis);
      return alongAxis(
        witness.endpoints[1].map(
          (value, index) => value - witness.endpoints[0][index]!
        ) as QuantizedTopologyPoint,
        filter.axis
      );
    default:
      return true;
  }
}

/**
 * Runs one pick on a body's exact topology: filters in order, an extreme
 * keeps every entity tied at it, and the result must hold exactly the
 * declared count. Equality is the witness quantum's; there is no tolerance.
 */
export function evaluatePick(
  pick: ScriptPick,
  topology: TopologyView,
  radius: (value: ParamValue) => number
): number[] {
  const isFace = pick.entity === 'face';
  let found: (TopologyFaceEntity | TopologyEdgeEntity)[] = [
    ...(isFace ? topology.faces : topology.edges)
  ];
  for (const filter of pick.filters) {
    if (filter.kind === 'extreme') {
      const points = found.map((entity) => entityPoint(entity, isFace));
      if (points.some((point) => point === null)) {
        throw new Error(
          `Pick #${pick.name}: a ${pick.entity} without a measured centre cannot be ordered along an axis.`
        );
      }
      const values = points.map((point) => point![filter.axis]);
      if (values.length === 0) break;
      const extreme = filter.max ? Math.max(...values) : Math.min(...values);
      found = found.filter((_, index) => values[index] === extreme);
    } else {
      found = found.filter((entity) => matches(entity, isFace, filter, radius));
    }
  }
  if (found.length !== pick.count) {
    throw new Error(
      `Pick #${pick.name} found ${found.length} ${pick.entity}${found.length === 1 ? '' : 's'}; it needs exactly ${pick.count}.`
    );
  }
  return found.map((entity) => entity.hash);
}

// --- Running ----------------------------------------------------------------

export type CustomFeatureStepData =
  | { featureKind: 'fillet'; edgeHashes: number[]; radius: number }
  | { featureKind: 'chamfer'; edgeHashes: number[]; distance: number }
  | { featureKind: 'shell'; openingFaceHashes: number[]; thickness: number };

/** What the exact build gives a running script: the body as it stands, and a step to run on it. */
export interface CustomFeatureHost {
  topology(): TopologyView;
  run(step: CustomFeatureStepData, index: number): void;
}

/**
 * The instance's inputs, evaluated against the document's parameters with
 * each input's declared quantity. An unknown or missing input refuses.
 */
export function evaluateScriptInputs(
  script: CompiledScript,
  inputs: Readonly<Record<string, ParamValue>>,
  scope: Record<string, number>,
  documentUnits: UnitSystem
): Record<string, number> {
  const declared = new Set(script.inputs.map((input) => input.name));
  for (const name of Object.keys(inputs)) {
    if (!declared.has(name)) {
      throw new Error(`Script ${script.id} has no input \`${name}\`.`);
    }
  }
  const values: Record<string, number> = {};
  for (const input of script.inputs) {
    const value = Object.hasOwn(inputs, input.name)
      ? inputs[input.name]!
      : input.defaultValue;
    if (value === null) {
      throw new Error(
        `Input \`${input.name}\` of ${script.id} has no value and no default.`
      );
    }
    let resolved: number;
    try {
      resolved =
        typeof value === 'number'
          ? value
          : evaluateFieldExpression(value, scope, {
              documentUnits,
              dimension: input.quantity === 'count' ? 'number' : input.quantity
            });
    } catch (error) {
      throw new Error(
        `Input \`${input.name}\`: ${error instanceof Error ? error.message : 'evaluation failed.'}`,
        { cause: error }
      );
    }
    if (!Number.isFinite(resolved)) {
      throw new Error(`Input \`${input.name}\` is not a finite number.`);
    }
    if (
      input.quantity === 'count' &&
      (!Number.isInteger(resolved) || resolved < 0)
    ) {
      throw new Error(
        `Input \`${input.name}\` is a count; ${resolved} is not a whole number.`
      );
    }
    values[input.name] = resolved;
  }
  return values;
}

/**
 * Runs a script on the host's body: each step's pick is evaluated on the
 * body as the steps before it left it, its size is evaluated with the
 * inputs in scope (they shadow parameters of the same name), and the host
 * runs the step. Any refusal stops the run; the host discards the partial
 * result.
 */
export function runCustomFeature(
  script: CompiledScript,
  inputs: Readonly<Record<string, ParamValue>>,
  scope: Record<string, number>,
  documentUnits: UnitSystem,
  host: CustomFeatureHost
): void {
  const values = evaluateScriptInputs(script, inputs, scope, documentUnits);
  const kinds: Record<string, ParameterKind> = { ...parameterKindsOf(scope) };
  for (const input of script.inputs) {
    if (input.quantity === 'count' || input.quantity === 'number') {
      delete kinds[input.name];
    } else kinds[input.name] = input.quantity;
  }
  const stepScope = withParameterKinds({ ...scope, ...values }, kinds);
  const evaluate = (value: ParamValue, dimension: 'length' | 'angle') =>
    typeof value === 'number'
      ? value
      : evaluateFieldExpression(value, stepScope, { documentUnits, dimension });
  script.steps.forEach((step, index) => {
    const pick = script.picks.get(step.pick)!;
    const hashes = evaluatePick(pick, host.topology(), (value) =>
      evaluate(value, 'length')
    );
    const size = evaluate(step.size, 'length');
    if (!Number.isFinite(size) || size <= 0) {
      throw new Error(
        `Step ${index + 1} (${step.kind}): its size must be greater than zero.`
      );
    }
    switch (step.kind) {
      case 'fillet':
        host.run(
          { featureKind: 'fillet', edgeHashes: hashes, radius: size },
          index
        );
        break;
      case 'chamfer':
        host.run(
          { featureKind: 'chamfer', edgeHashes: hashes, distance: size },
          index
        );
        break;
      case 'shell':
        host.run(
          { featureKind: 'shell', openingFaceHashes: hashes, thickness: size },
          index
        );
        break;
    }
  });
}
