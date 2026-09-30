import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { FREECAD_IMPORT_LIMITS, type FreecadImportLimits } from './limits';
import { extractFreecadEntry, inspectFreecadArchive } from './zip';

type Xml = Record<string, unknown>;
function record(value: unknown): Xml {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Xml)
    : {};
}
function list(value: unknown): Xml[] {
  return (
    Array.isArray(value) ? value : value === undefined ? [] : [value]
  ).map(record);
}
function attribute(value: Xml, key: string): string {
  return typeof value[`@_${key}`] === 'string'
    ? (value[`@_${key}`] as string)
    : '';
}
function properties(object: Xml): Map<string, Xml> {
  const result = new Map<string, Xml>();
  for (const prop of list(record(object['Properties'])['Property'])) {
    const name = attribute(prop, 'name');
    if (!name || result.has(name))
      throw new Error('FreeCAD has duplicate or unnamed properties.');
    result.set(name, prop);
  }
  return result;
}
function xml(bytes: Uint8Array): Xml {
  if (bytes.byteLength > 8 * 1024 * 1024)
    throw new Error('FreeCAD XML exceeds the 8 MB limit.');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (/<!DOCTYPE|<!ENTITY/i.test(text))
    throw new Error('FreeCAD XML entities and document types are unsupported.');
  if (XMLValidator.validate(text) !== true)
    throw new Error('FreeCAD XML is malformed.');
  return record(
    new XMLParser({
      ignoreAttributes: false,
      parseTagValue: false,
      parseAttributeValue: false,
      processEntities: true
    }).parse(text)
  );
}
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
function placement(prop: Xml | undefined): number[] {
  if (!prop) return [...IDENTITY];
  const p = record(prop['PropertyPlacement']);
  const values = ['Px', 'Py', 'Pz', 'Q0', 'Q1', 'Q2', 'Q3'].map((key) => {
    const raw = attribute(p, key);
    if (!raw || !Number.isFinite(Number(raw)))
      throw new Error('FreeCAD has an invalid container placement.');
    return Number(raw);
  });
  const [tx, ty, tz, x, y, z, w] = values as [
    number,
    number,
    number,
    number,
    number,
    number,
    number
  ];
  if (Math.abs(x * x + y * y + z * z + w * w - 1) > 1e-10)
    throw new Error('FreeCAD has a non-unit placement quaternion.');
  return [
    1 - 2 * (y * y + z * z),
    2 * (x * y - z * w),
    2 * (x * z + y * w),
    tx,
    2 * (x * y + z * w),
    1 - 2 * (x * x + z * z),
    2 * (y * z - x * w),
    ty,
    2 * (x * z - y * w),
    2 * (y * z + x * w),
    1 - 2 * (x * x + y * y),
    tz
  ];
}
function links(prop: Xml | undefined): string[] {
  return list(record(prop?.['LinkList'])['Link']).map((link) =>
    attribute(link, 'value')
  );
}
function visibility(prop: Xml | undefined): boolean {
  if (!prop) return true;
  const raw = attribute(record(prop['Bool']), 'value');
  if (raw !== 'true' && raw !== 'false')
    throw new Error('FreeCAD has an invalid visibility property.');
  return raw === 'true';
}
export interface FreecadSavedShape {
  /** Internal identity, never evaluated as a command or expression. */
  objectName: string;
  brep: Uint8Array;
  /** Parent Part placements only: the shape already includes its own placement. */
  parentPlacements: number[][];
}

/** Read saved geometry only. Python proxies, expressions and macros are never run. */
export function readFreecadShapes(
  bytes: Uint8Array,
  limits: FreecadImportLimits = FREECAD_IMPORT_LIMITS
): FreecadSavedShape[] {
  const archive = inspectFreecadArchive(bytes, limits);
  const doc = record(xml(extractFreecadEntry(bytes, limits))['Document']);
  if (!['2', '3', '4'].includes(attribute(doc, 'SchemaVersion'))) {
    throw new Error(
      'Unsupported FreeCAD document schema. Export the model as STEP in FreeCAD.'
    );
  }
  const definitions = list(record(doc['Objects'])['Object']);
  if (!definitions.length || definitions.length > limits.maxObjects)
    throw new Error('FreeCAD object count is empty or exceeds the limit.');
  const data = new Map<string, Map<string, Xml>>();
  for (const object of list(record(doc['ObjectData'])['Object'])) {
    const name = attribute(object, 'name');
    if (!name || data.has(name))
      throw new Error('FreeCAD has duplicate or unnamed objects.');
    data.set(name, properties(object));
  }
  const types = new Map<string, string>();
  for (const object of definitions) {
    const name = attribute(object, 'name');
    if (!name || types.has(name) || !data.has(name))
      throw new Error(
        'FreeCAD object definitions do not match their saved data.'
      );
    types.set(name, attribute(object, 'type'));
  }
  if (data.size !== types.size)
    throw new Error(
      'FreeCAD object definitions do not match their saved data.'
    );
  const gui = new Map<string, Map<string, Xml>>();
  if (archive.entries.some((entry) => entry.name === 'GuiDocument.xml')) {
    const guiDoc = record(
      xml(extractFreecadEntry(bytes, limits, 'GuiDocument.xml'))['GuiDocument']
    );
    for (const provider of list(
      record(guiDoc['ViewProviderData'])['ViewProvider']
    )) {
      const name = attribute(provider, 'name');
      if (gui.has(name))
        throw new Error('FreeCAD has duplicate view providers.');
      gui.set(name, properties(provider));
    }
  }
  const visible = (name: string): boolean =>
    visibility(
      gui.get(name)?.get('Visibility') ?? data.get(name)?.get('Visibility')
    );
  const bodyMembers = new Set<string>();
  const parents = new Map<string, string>();
  for (const [name, type] of types) {
    if (type !== 'PartDesign::Body' && type !== 'App::Part') continue;
    for (const child of links(data.get(name)?.get('Group'))) {
      if (!types.has(child) || parents.has(child))
        throw new Error('FreeCAD has missing or multiply parented objects.');
      parents.set(child, name);
      if (type === 'PartDesign::Body') bodyMembers.add(child);
    }
  }
  const shapes: FreecadSavedShape[] = [];
  for (const [name, type] of types) {
    if (bodyMembers.has(name) || !visible(name)) continue;
    const transforms: number[][] = [];
    const seen = new Set([name]);
    let parent = parents.get(name);
    let hidden = false;
    while (parent) {
      if (seen.has(parent)) throw new Error('FreeCAD has cyclic containers.');
      seen.add(parent);
      if (!visible(parent)) hidden = true;
      transforms.push(placement(data.get(parent)?.get('Placement')));
      parent = parents.get(parent);
    }
    if (hidden) continue;
    if (type.startsWith('App::Link'))
      throw new Error(
        'FreeCAD linked instances are unsupported. Export them as STEP in FreeCAD.'
      );
    if (type.startsWith('Sketcher::') || type === 'App::Part') continue;
    const shape = data.get(name)?.get('Shape');
    if (!shape) {
      if (type === 'PartDesign::Body')
        throw new Error(
          'FreeCAD Body has no saved final shape. Recompute and save it in FreeCAD.'
        );
      continue;
    }
    if (attribute(shape, 'type') !== 'Part::PropertyPartShape')
      throw new Error('Unsupported FreeCAD saved shape property.');
    const file = attribute(record(shape['Part']), 'file');
    if (!file)
      throw new Error(
        'FreeCAD has an unsaved or unsupported shape. Recompute and save it in FreeCAD, or export STEP.'
      );
    const brep = extractFreecadEntry(bytes, limits, file);
    if (!brep.byteLength)
      throw new Error(
        'FreeCAD has an empty saved shape. Recompute and save it in FreeCAD.'
      );
    shapes.push({ objectName: name, brep, parentPlacements: transforms });
    if (shapes.length > limits.maxBodies)
      throw new Error('FreeCAD body count exceeds the import limit.');
  }
  if (!shapes.length)
    throw new Error(
      'FreeCAD contains no visible saved solid bodies. Recompute and save the model, or export STEP.'
    );
  return shapes;
}
