/**
 * Palette row names for what the model is made of. A feature keeps its own
 * name, but the row says what picking it does: a fillet named "Fillet" sat
 * in the list as a second "Fillet" beside the Fillet tool, and picking the
 * wrong one opened history instead of starting a new fillet.
 */
export function featurePaletteLabel(featureName: string): string {
  return `Go to ${featureName}`;
}

/**
 * Numbers every repeat of a label already in the list, in list order: two
 * holes both named "Hole" read "Go to Hole" and "Go to Hole (2)". The first
 * keeps its name, so tools and commands, which come first, never change.
 */
export function withDistinctLabels<Command extends { label: string }>(
  commands: Command[]
): Command[] {
  const taken = new Set<string>();
  return commands.map((command) => {
    if (!taken.has(command.label)) {
      taken.add(command.label);
      return command;
    }
    let ordinal = 2;
    while (taken.has(`${command.label} (${ordinal})`)) {
      ordinal += 1;
    }
    const label = `${command.label} (${ordinal})`;
    taken.add(label);
    return { ...command, label };
  });
}
