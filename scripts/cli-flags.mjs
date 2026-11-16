/**
 * Strict `--flag value` parsing for deploy scripts. A misspelled, `=`-joined,
 * repeated or value-less flag throws instead of being ignored: ignoring one
 * would fall back to the beta defaults and point a stable deploy at beta.
 */
export function parseFlags(argv, allowed) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!allowed.includes(flag)) {
      throw new Error(
        `Unknown argument ${flag}; expected ${allowed.join(', ')}, each followed by a value`
      );
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--') || !value.trim()) {
      throw new Error(`${flag} needs a value`);
    }
    if (Object.hasOwn(values, flag)) throw new Error(`${flag} is given twice`);
    values[flag] = value;
    index += 1;
  }
  return values;
}
