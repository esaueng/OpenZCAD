// Mirrored in the app integrations. No free-form dimensions or diagnostic text.
export const TIMINGS = [
  'lt_100ms',
  '100ms_1s',
  '1s_10s',
  '10s_60s',
  'gte_60s'
] as const;
export const SIZES = ['lt_1mib', '1_10mib', '10_100mib', 'gte_100mib'] as const;
export const PARTS = ['0', '1', '2_10', '11_100', 'gte_101'] as const;
export const DIAGNOSTICS = [
  'error_runtime',
  'error_import',
  'error_export',
  'error_mesh',
  'error_solver',
  'error_cloud_save',
  'error_cloud_load',
  'error_storage',
  'error_feature',
  'error_render'
] as const;
export const CAD_OPERATIONS = [
  'transaction',
  'primitive.add',
  'sketch.add',
  'sketch.update',
  'sketch.translate',
  'sketch.object.add',
  'sketch.object.update',
  'sketch.object.delete',
  'sketch.constraint.add',
  'sketch.constraint.delete',
  'sketch.constraint.label-position',
  'sketch.composite.add',
  'reference-dimension.add',
  'reference-dimension.delete',
  'reference-dimension.label-position',
  'feature.extrude',
  'feature.revolve',
  'feature.loft',
  'feature.sweep',
  'feature.helical-sweep',
  'feature.boolean',
  'feature.transform',
  'feature.mirror',
  'feature.split',
  'feature.datum-plane',
  'feature.datum-axis',
  'feature.hole',
  'feature.gear',
  'feature.thread',
  'feature.shell',
  'feature.solid-offset',
  'feature.draft',
  'feature.thicken',
  'feature.direct-edit',
  'feature.fillet',
  'feature.chamfer',
  'feature.pattern',
  'feature.update',
  'feature.delete',
  'feature.reorder',
  'parameter.set',
  'parameter.configure-toggle',
  'parameter.expose',
  'parameter.describe',
  'parameter.rename',
  'parameter.delete',
  'import.mesh',
  'import.step',
  'import.shapr-guided',
  'node.rename',
  'node.metadata.set',
  'drawing.sheet.add',
  'drawing.sheet.update',
  'drawing.sheet.delete',
  'drawing.view.add',
  'drawing.view.update',
  'drawing.view.delete',
  'objectFolder.create',
  'objectFolder.rename',
  'objectFolder.delete',
  'objectFolder.move',
  'drawing.annotation.add',
  'drawing.annotation.update',
  'drawing.annotation.delete',
  'reference-image.add',
  'reference-image.update',
  'reference-image.delete',
  'assembly.components.add',
  'assembly.component.update',
  'assembly.component.delete',
  'assembly.joint.add',
  'assembly.joint.update',
  'assembly.joint.delete',
  'assembly.pose.set',
  'assembly.position.save',
  'assembly.position.delete',
  'assembly.study.set',
  'assembly.study.delete'
] as const;
/**
 * `kernel_refused`: one aggregate observation per new kernel refusal, opt-in
 * like every expanded metric. The bucket is the whole payload and is built
 * only from the fixed vocabularies below, joined in a fixed order:
 *
 *   operation|family|kernelOperation|category|code|warningKind|target|neighbours
 *
 * No geometry, dimensions, names, hashes, ids, file names or free text can
 * pass: every field is a closed list except `code`, the kernel's own stable
 * snake_case identifier, which is shape-checked (letters and underscores only)
 * and bounded instead, because the pinned kernel does not publish its code
 * list. Anything else is `other`.
 */
export const KERNEL_REFUSED_EVENT = 'kernel_refused' as const;
export const REFUSAL_DIRECT_EDIT_OPERATIONS = [
  'resize-through-hole',
  'resize-imported-blind-hole',
  'resize-imported-counterbore',
  'resize-imported-countersink',
  'remove-face-feature',
  'offset-face',
  'set-face-distance',
  'resize-cylindrical-face',
  'resize-blend',
  'remove-blends'
] as const;
export const REFUSAL_OPERATIONS = [
  'primitive',
  'sketch',
  'extrude',
  'revolve',
  'loft',
  'sweep',
  'helical-sweep',
  'boolean',
  'transform',
  'mirror',
  'shell',
  'solid-offset',
  'draft',
  'thicken',
  'fillet',
  'chamfer',
  'pattern',
  'split',
  'hole',
  'gear',
  'thread',
  'direct-edit',
  'imported-step',
  'imported-mesh',
  'datum-plane',
  'datum-axis',
  ...REFUSAL_DIRECT_EDIT_OPERATIONS.map((kind) => `direct-edit.${kind}`),
  'other'
] as const;
export const REFUSAL_FAMILIES = [
  'boolean',
  'direct-edit',
  'validation',
  'healing',
  'import',
  'blend',
  'gear',
  'thread',
  'other',
  'none'
] as const;
export const REFUSAL_KERNEL_OPERATIONS = [
  ...REFUSAL_DIRECT_EDIT_OPERATIONS,
  'cut',
  'fuse',
  'intersect',
  'other',
  'none'
] as const;
export const REFUSAL_CATEGORIES = [
  'invalid_input',
  'invalid_topology',
  'unsupported',
  'nonconvergence',
  'resource_limit',
  'tolerance_violation',
  'quality_refused',
  'cancelled',
  'internal',
  'other',
  'none'
] as const;
export const REFUSAL_WARNING_KINDS = ['build-failed', 'refusal'] as const;
export const REFUSAL_SURFACES = [
  'plane',
  'cylinder',
  'cone',
  'sphere',
  'torus',
  'bspline',
  'other'
] as const;
/**
 * A kernel code: lower-case words joined by underscores, at most 48 chars.
 * No digits, so a generated id (`prefix_<uuid>`), hash or dimension cannot
 * take this slot, and never starting with one of the app's id prefixes, so
 * a hand-made id cannot either. `none` and `other` match too.
 */
export const REFUSAL_CODE_PATTERN =
  /^(?=.{1,48}$)(?!(?:user|owner|proj|project|feat|body|sketch|ent|node|param|parameter|artifact|asset|rev|sref|scon|scmp)_)[a-z]+(?:_[a-z]+)*$/;
export const KERNEL_REFUSED_BUCKET_MAX_LENGTH = 200;
export interface KernelRefusedBucket {
  operation: (typeof REFUSAL_OPERATIONS)[number];
  family: (typeof REFUSAL_FAMILIES)[number];
  kernelOperation: (typeof REFUSAL_KERNEL_OPERATIONS)[number];
  category: (typeof REFUSAL_CATEGORIES)[number];
  code: string;
  warningKind: (typeof REFUSAL_WARNING_KINDS)[number];
  /** The target face's surface, or `none` when the operation has no face. */
  target: (typeof REFUSAL_SURFACES)[number] | 'none';
  /** Distinct neighbour surfaces, in REFUSAL_SURFACES order. */
  neighbours: (typeof REFUSAL_SURFACES)[number][];
}
function member<T extends string>(
  list: readonly T[],
  value: unknown
): value is T {
  return (
    typeof value === 'string' && (list as readonly string[]).includes(value)
  );
}
/** The canonical wire form, or null when any field is outside its list. */
export function formatKernelRefusedBucket(
  value: KernelRefusedBucket
): string | null {
  const neighbours = value.neighbours;
  if (
    !member(REFUSAL_OPERATIONS, value.operation) ||
    !member(REFUSAL_FAMILIES, value.family) ||
    !member(REFUSAL_KERNEL_OPERATIONS, value.kernelOperation) ||
    !member(REFUSAL_CATEGORIES, value.category) ||
    typeof value.code !== 'string' ||
    !REFUSAL_CODE_PATTERN.test(value.code) ||
    !member(REFUSAL_WARNING_KINDS, value.warningKind) ||
    !(value.target === 'none' || member(REFUSAL_SURFACES, value.target)) ||
    !Array.isArray(neighbours) ||
    !neighbours.every((surface) => member(REFUSAL_SURFACES, surface))
  )
    return null;
  const ordered = REFUSAL_SURFACES.filter((surface) =>
    neighbours.includes(surface)
  );
  const bucket = [
    value.operation,
    value.family,
    value.kernelOperation,
    value.category,
    value.code,
    value.warningKind,
    value.target,
    ordered.length > 0 ? ordered.join('+') : 'none'
  ].join('|');
  return bucket.length <= KERNEL_REFUSED_BUCKET_MAX_LENGTH ? bucket : null;
}
/** Strict inverse: only a bucket this module could have formatted parses. */
export function parseKernelRefusedBucket(
  bucket: unknown
): KernelRefusedBucket | null {
  if (
    typeof bucket !== 'string' ||
    bucket.length > KERNEL_REFUSED_BUCKET_MAX_LENGTH
  )
    return null;
  const parts = bucket.split('|');
  if (parts.length !== 8) return null;
  const [
    operation,
    family,
    kernelOperation,
    category,
    code,
    warningKind,
    target,
    rest
  ] = parts as [string, string, string, string, string, string, string, string];
  const neighbours = rest === 'none' ? [] : rest.split('+');
  const parsed = {
    operation,
    family,
    kernelOperation,
    category,
    code,
    warningKind,
    target,
    neighbours
  } as KernelRefusedBucket;
  return formatKernelRefusedBucket(parsed) === bucket ? parsed : null;
}
export const EXPANDED: Readonly<Record<string, readonly string[]>> = {
  feature_operation: CAD_OPERATIONS,
  cloud_status: [
    'unauthorized',
    'forbidden',
    'conflict',
    'too_large',
    'rate_limited',
    'server',
    'network',
    'other'
  ],
  project_size: SIZES,
  part_count: PARTS,
  transfer_upload: SIZES,
  transfer_download: SIZES,
  mesh_latency: TIMINGS,
  solver_latency: TIMINGS,
  export_latency: TIMINGS,
  save_latency: TIMINGS,
  solver_backend: ['cpu', 'webgpu', 'unknown'],
  feature_category: [
    'create',
    'edit',
    'import',
    'export',
    'mesh',
    'solve',
    'measure',
    'other'
  ],
  ...Object.fromEntries(DIAGNOSTICS.map((event) => [event, ['none']]))
};
export function expandedMetric(
  event: unknown,
  bucket: unknown,
  app: string
): boolean {
  if (!['openzcad', 'openfea'].includes(app)) return false;
  if (typeof event !== 'string' || typeof bucket !== 'string') return false;
  if (
    app === 'openzcad' &&
    [
      'error_mesh',
      'error_solver',
      'mesh_latency',
      'solver_latency',
      'solver_backend'
    ].includes(event)
  )
    return false;
  if (
    app !== 'openzcad' &&
    ['feature_operation', 'cloud_status'].includes(event)
  )
    return false;
  if (event === KERNEL_REFUSED_EVENT)
    return app === 'openzcad' && parseKernelRefusedBucket(bucket) !== null;
  return (
    Object.hasOwn(EXPANDED, event) &&
    (EXPANDED[event]?.includes(bucket) ?? false)
  );
}
export type Report = {
  schema: 2;
  app: 'openzcad' | 'openfea';
  rows: { event: string; bucket: string; count: number }[];
};
export function parseReport(value: unknown): Report | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).sort().join(',') !== 'app,rows,schema' ||
    v.schema !== 2 ||
    typeof v.app !== 'string' ||
    !['openzcad', 'openfea'].includes(v.app) ||
    !Array.isArray(v.rows) ||
    v.rows.length > 128
  )
    return null;
  const seen = new Set<string>();
  for (const raw of v.rows as unknown[]) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const r = raw as Record<string, unknown>;
    if (
      !r ||
      typeof r !== 'object' ||
      Array.isArray(r) ||
      Object.keys(r).sort().join(',') !== 'bucket,count,event' ||
      typeof r.event !== 'string' ||
      typeof r.bucket !== 'string' ||
      !expandedMetric(r.event, r.bucket, String(v.app)) ||
      typeof r.count !== 'number' ||
      !Number.isSafeInteger(r.count) ||
      r.count < 1 ||
      r.count > 10000000
    )
      return null;
    const key = `${r.event}:${r.bucket}`;
    if (seen.has(key)) return null;
    seen.add(key);
  }
  return v as Report;
}
export const CENSUS_FIELDS = [
  'accounts',
  'projects',
  'revisions',
  'storedBytes',
  'logicalBytes',
  'unknownArtifacts',
  'lt1mib',
  'mib1to10',
  'mib10to100',
  'gte100mib'
] as const;
export type Census = Record<(typeof CENSUS_FIELDS)[number], number> & {
  generation: number;
};
export type CensusRow = Census & { day: string; app: 'openzcad' };
export function census(value: unknown, app: string): Census | null {
  if (
    app !== 'openzcad' ||
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value)
  )
    return null;
  const v = value as Record<string, unknown>;
  const keys = [...CENSUS_FIELDS, 'generation'];
  if (
    Object.keys(v).length !== keys.length ||
    keys.some(
      (k) =>
        !Object.hasOwn(v, k) ||
        typeof v[k] !== 'number' ||
        !Number.isSafeInteger(v[k]) ||
        v[k] < 0 ||
        v[k] > 1000000000000000
    )
  )
    return null;
  const c = v as Census;
  if (
    c.generation < 1 ||
    c.projects !== c.lt1mib + c.mib1to10 + c.mib10to100 + c.gte100mib ||
    (c.accounts === 0 && CENSUS_FIELDS.some((k) => c[k] !== 0))
  )
    return null;
  return { ...c };
}
