/**
 * Interpreter for the JSON Schema vocabulary used by the CAD reply contract.
 * No generated code/eval is needed in Workers. Unknown keywords fail closed;
 * the contract coverage test requires any new vocabulary to be implemented.
 */
export const ASSISTANT_SCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
  'type',
  'const',
  'enum',
  'anyOf',
  'description',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'minItems',
  'maxItems',
  'pattern',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum'
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function matchesType(value: unknown, type: unknown): boolean {
  switch (type) {
    case 'null':
      return value === null;
    case 'object':
      return record(value) !== undefined;
    case 'array':
      return Array.isArray(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    default:
      return false;
  }
}

export function matchesAssistantSchema(
  value: unknown,
  schema: unknown,
  depth = 0
): boolean {
  const rules = record(schema);
  if (
    !rules ||
    depth > 64 ||
    Object.keys(rules).some((key) => !ASSISTANT_SCHEMA_KEYWORDS.has(key))
  ) {
    return false;
  }
  if ('const' in rules && value !== rules.const) return false;
  if (
    'enum' in rules &&
    (!Array.isArray(rules.enum) || !rules.enum.includes(value))
  )
    return false;
  if ('type' in rules && !matchesType(value, rules.type)) return false;
  if (
    'anyOf' in rules &&
    (!Array.isArray(rules.anyOf) ||
      !rules.anyOf.some((choice) =>
        matchesAssistantSchema(value, choice, depth + 1)
      ))
  ) {
    return false;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return false;
    if (typeof rules.minimum === 'number' && value < rules.minimum)
      return false;
    if (typeof rules.maximum === 'number' && value > rules.maximum)
      return false;
    if (
      typeof rules.exclusiveMinimum === 'number' &&
      value <= rules.exclusiveMinimum
    )
      return false;
    if (
      typeof rules.exclusiveMaximum === 'number' &&
      value >= rules.exclusiveMaximum
    )
      return false;
  }
  if (typeof value === 'string' && typeof rules.pattern === 'string') {
    if (!new RegExp(rules.pattern).test(value)) return false;
  }
  if (Array.isArray(value)) {
    if (typeof rules.minItems === 'number' && value.length < rules.minItems)
      return false;
    if (typeof rules.maxItems === 'number' && value.length > rules.maxItems)
      return false;
    if (
      rules.items &&
      !value.every((item) =>
        matchesAssistantSchema(item, rules.items, depth + 1)
      )
    )
      return false;
  }
  const object = record(value);
  if (object) {
    if (
      Array.isArray(rules.required) &&
      !rules.required.every(
        (key) => typeof key === 'string' && Object.hasOwn(object, key)
      )
    )
      return false;
    const properties = record(rules.properties) ?? {};
    for (const [key, child] of Object.entries(object)) {
      if (Object.hasOwn(properties, key)) {
        if (!matchesAssistantSchema(child, properties[key], depth + 1))
          return false;
      } else if (rules.additionalProperties === false) {
        return false;
      }
    }
  }
  return true;
}
