/**
 * Combine independently exported STEP roots without introducing an assembly.
 * Only entity identities change; geometry, topology, units and pcurves remain
 * exactly as emitted by OCCT. References inside STEP strings/comments are text.
 */
export function combineStepRoots(roots: string[]): string {
  if (!roots.length)
    throw new Error('FreeCAD conversion produced no STEP roots.');
  let nextId = 0;
  const sections = roots.map((root) => {
    const start = root.indexOf('DATA;');
    const end = root.indexOf('ENDSEC;', start + 5);
    if (start < 0 || end < 0)
      throw new Error('FreeCAD converter produced malformed STEP.');
    const body = root.slice(start + 5, end);
    const offset = nextId;
    let maximum = 0;
    // OCCT emits standard Part 21 escaped quotes and block comments.
    const remapped = body.replace(
      /'(?:[^']|'')*'|\/\*[\s\S]*?\*\/|#(\d+)/g,
      (token, id: string | undefined) => {
        if (id === undefined) return token;
        const value = Number(id);
        if (!Number.isSafeInteger(value) || value < 1)
          throw new Error('FreeCAD STEP entity identity is invalid.');
        maximum = Math.max(maximum, value);
        return `#${value + offset}`;
      }
    );
    nextId += maximum;
    if (!Number.isSafeInteger(nextId))
      throw new Error('FreeCAD STEP identities exceed the supported range.');
    return remapped;
  });
  const header = roots[0]!.slice(0, roots[0]!.indexOf('DATA;') + 5);
  return `${header}${sections.join('\n')}ENDSEC;\nEND-ISO-10303-21;\n`;
}
