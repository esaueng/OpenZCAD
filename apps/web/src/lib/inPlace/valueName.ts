/**
 * How a sentence names one value of an in-place tool: the tool's title and
 * the value's label, lower-cased ("Box width", "Hole countersink angle").
 *
 * A label that opens with the title's last word would repeat it, so that
 * word is said once: Solid offset's "Offset" is "Solid offset", not "Solid
 * offset offset", and a label "Offset distance" would be "Solid offset
 * distance".
 */
export function toolValueName(title: string, label: string): string {
  const words = label.toLowerCase().split(/\s+/).filter(Boolean);
  const last = title.trim().split(/\s+/).at(-1)?.toLowerCase();
  const rest = words[0] === last ? words.slice(1) : words;
  return [title.trim(), ...rest].join(' ');
}
