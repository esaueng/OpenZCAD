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
  'drawing.annotation.add',
  'drawing.annotation.update',
  'drawing.annotation.delete'
] as const;
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
