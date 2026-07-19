const STEP_REAL_SOURCE =
  '[+-]?(?:(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[Ee][+-]?\\d+)?)';

interface StepEntity {
  id: number;
  body: string;
  bodyStart: number;
  bodyEnd: number;
}

interface Replacement {
  start: number;
  end: number;
  value: string;
}

/**
 * Split the first STEP DATA section into entities without treating semicolons
 * inside quoted strings or comments as statement terminators.
 */
function scanStepEntities(text: string): StepEntity[] {
  const dataStart = text.indexOf('DATA;');
  if (dataStart < 0) {
    return [];
  }
  const dataEnd = text.indexOf('ENDSEC;', dataStart + 5);
  if (dataEnd < 0) {
    return [];
  }

  const entities: StepEntity[] = [];
  let statementStart = dataStart + 5;
  let inString = false;
  let inComment = false;

  for (let index = statementStart; index < dataEnd; index += 1) {
    const current = text[index];
    const next = text[index + 1];

    if (inComment) {
      if (current === '*' && next === '/') {
        inComment = false;
        index += 1;
      }
      continue;
    }
    if (!inString && current === '/' && next === '*') {
      inComment = true;
      index += 1;
      continue;
    }
    if (current === "'") {
      if (inString && next === "'") {
        index += 1;
      } else {
        inString = !inString;
      }
      continue;
    }
    if (current !== ';' || inString) {
      continue;
    }

    const statement = text.slice(statementStart, index);
    const header =
      /^\s*(?:\/\*[\s\S]*?\*\/\s*)*#(\d+)\s*=/.exec(statement);
    if (header) {
      const bodyStart = statementStart + header[0].length;
      entities.push({
        id: Number(header[1]),
        body: text.slice(bodyStart, index),
        bodyStart,
        bodyEnd: index
      });
    }
    statementStart = index + 1;
  }

  return entities;
}

function parseReferences(text: string): number[] {
  return Array.from(text.matchAll(/#(\d+)/g), (match) => Number(match[1]));
}

function functionArguments(text: string, name: string): string | null {
  const upper = text.toUpperCase();
  const functionStart = upper.indexOf(name.toUpperCase());
  if (functionStart < 0) {
    return null;
  }
  const open = text.indexOf('(', functionStart + name.length);
  if (open < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  for (let index = open; index < text.length; index += 1) {
    const current = text[index];
    const next = text[index + 1];
    if (current === "'") {
      if (inString && next === "'") {
        index += 1;
      } else {
        inString = !inString;
      }
      continue;
    }
    if (inString) {
      continue;
    }
    if (current === '(') {
      depth += 1;
    } else if (current === ')') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(open + 1, index);
      }
    }
  }
  return null;
}

function conversionFactorFromUnit(
  unitBody: string,
  entities: Map<number, StepEntity>
): number | null {
  const conversion = functionArguments(unitBody, 'CONVERSION_BASED_UNIT');
  if (conversion === null) {
    return /SI_UNIT\s*\(\s*\$\s*,\s*\.RADIAN\.\s*\)/i.test(unitBody)
      ? 1
      : null;
  }

  const factorReference = parseReferences(conversion)[0];
  const factorBody =
    factorReference === undefined
      ? undefined
      : entities.get(factorReference)?.body;
  if (factorBody) {
    const match = new RegExp(
      `PLANE_ANGLE_MEASURE\\s*\\(\\s*(${STEP_REAL_SOURCE})\\s*\\)`,
      'i'
    ).exec(factorBody);
    const factor = match ? Number(match[1]) : Number.NaN;
    if (Number.isFinite(factor) && factor > 0) {
      return factor;
    }
  }

  // DEGREE is a standardized conversion-based plane-angle unit. Keep this
  // fallback for exporters that omit the otherwise redundant factor entity.
  return /^\s*'(?:DEGREE|DEGREES)'\s*,/i.test(conversion)
    ? Math.PI / 180
    : null;
}

function declaredPlaneAngleScale(entities: StepEntity[]): number | null {
  const byId = new Map(entities.map((entity) => [entity.id, entity]));
  const factors: number[] = [];

  for (const context of entities) {
    const assignedUnits = functionArguments(
      context.body,
      'GLOBAL_UNIT_ASSIGNED_CONTEXT'
    );
    if (assignedUnits === null) {
      continue;
    }
    for (const reference of parseReferences(assignedUnits)) {
      const unit = byId.get(reference);
      if (!unit || !/PLANE_ANGLE_UNIT\s*\(\s*\)/i.test(unit.body)) {
        continue;
      }
      const factor = conversionFactorFromUnit(unit.body, byId);
      if (factor !== null) {
        factors.push(factor);
      }
    }
  }

  if (factors.length === 0) {
    return null;
  }
  const first = factors[0]!;
  const consistent = factors.every(
    (factor) => Math.abs(factor - first) <= Math.max(1, Math.abs(first)) * 1e-12
  );
  return consistent ? first : null;
}

/**
 * BrepKit currently interprets CONICAL_SURFACE half-angles as radians without
 * consulting STEP's GLOBAL_UNIT_ASSIGNED_CONTEXT. Convert only those angles in
 * the transient kernel input when the file unambiguously declares a different
 * plane-angle unit. The document keeps the original STEP text unchanged.
 */
export function normalizeStepPlaneAnglesForKernel(text: string): string {
  const entities = scanStepEntities(text);
  const scale = declaredPlaneAngleScale(entities);
  if (scale === null || Math.abs(scale - 1) <= 1e-15) {
    return text;
  }

  const conicalSurface = new RegExp(
    `^(\\s*CONICAL_SURFACE\\s*\\(\\s*(?:'(?:''|[^'])*'|\\$)\\s*,\\s*#\\d+\\s*,\\s*${STEP_REAL_SOURCE}\\s*,\\s*)(${STEP_REAL_SOURCE})(\\s*\\)\\s*)$`,
    'i'
  );
  const replacements: Replacement[] = [];

  for (const entity of entities) {
    const match = conicalSurface.exec(entity.body);
    if (!match) {
      continue;
    }
    const inputAngle = Number(match[2]);
    const angleRadians = inputAngle * scale;
    if (!Number.isFinite(angleRadians)) {
      continue;
    }
    replacements.push({
      start: entity.bodyStart,
      end: entity.bodyEnd,
      value: `${match[1]}${angleRadians.toPrecision(17)}${match[3]}`
    });
  }

  let normalized = text;
  for (const replacement of replacements.reverse()) {
    normalized =
      normalized.slice(0, replacement.start) +
      replacement.value +
      normalized.slice(replacement.end);
  }
  return normalized;
}
