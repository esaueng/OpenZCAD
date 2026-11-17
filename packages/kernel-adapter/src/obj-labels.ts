/**
 * I04: one OBJ holding every body as its own named object (`o`), in a
 * material named after its display colour (`usemtl`), with the companion
 * MTL that defines those materials. The parts are the translator's per-body
 * OBJs; their vertex and normal indices are renumbered into one file.
 */
export interface ObjBodyPart {
  text: string;
  name: string;
  /** `#rrggbb` sRGB. */
  color: string;
}

function materialName(color: string): string {
  return `color_${color.toLowerCase().replace('#', '')}`;
}

/** An `o` name runs to the end of its line and may not start a comment. */
function objName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().replace(/^#/, '_') || 'Body';
}

export function mergeObjBodies(
  parts: readonly ObjBodyPart[],
  materialLibrary: string
): { obj: string; mtl: string } {
  const lines = ['# OpenZCAD OBJ export', `mtllib ${materialLibrary}`];
  let vertices = 0;
  let normals = 0;
  let textures = 0;
  const colors = new Set<string>();
  for (const part of parts) {
    lines.push(`o ${objName(part.name)}`, `usemtl ${materialName(part.color)}`);
    colors.add(part.color.toLowerCase());
    let v = 0;
    let vn = 0;
    let vt = 0;
    for (const raw of part.text.split('\n')) {
      const line = raw.trim();
      if (line.startsWith('v ')) {
        v += 1;
        lines.push(line);
      } else if (line.startsWith('vn ')) {
        vn += 1;
        lines.push(line);
      } else if (line.startsWith('vt ')) {
        vt += 1;
        lines.push(line);
      } else if (line.startsWith('f ')) {
        const corners = line
          .slice(2)
          .trim()
          .split(/\s+/)
          .map((corner) => {
            const [a, b, c] = corner.split('/');
            const shift = (value: string | undefined, by: number) =>
              value === undefined || value === ''
                ? value
                : String(Number(value) + by);
            return [shift(a, vertices), shift(b, textures), shift(c, normals)]
              .slice(0, corner.split('/').length)
              .map((value) => value ?? '')
              .join('/');
          });
        lines.push(`f ${corners.join(' ')}`);
      }
    }
    vertices += v;
    normals += vn;
    textures += vt;
  }
  const mtl = ['# OpenZCAD materials'];
  for (const color of colors) {
    const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/.exec(color);
    const [r, g, b] = match
      ? match.slice(1).map((hex) => (parseInt(hex, 16) / 255).toFixed(6))
      : ['0.800000', '0.800000', '0.800000'];
    mtl.push(
      `newmtl ${materialName(color)}`,
      `Kd ${r} ${g} ${b}`,
      'd 1',
      'illum 1',
      ''
    );
  }
  return { obj: `${lines.join('\n')}\n`, mtl: `${mtl.join('\n')}\n` };
}
