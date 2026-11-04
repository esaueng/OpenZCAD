/** Presentation only: the expression identifier and document never change. */
export function parameterDisplayName(
  name: string,
  description?: string
): string {
  // A short, authored description can name the control. Never guess what a
  // user's abbreviation measures: r can mean rows as readily as radius.
  const explicit = description?.trim();
  if (
    explicit &&
    explicit.length <= 48 &&
    /^[\p{L}\p{N}][\p{L}\p{N} -]*$/u.test(explicit)
  ) {
    return explicit;
  }
  const parts = name.replace(/([a-z\d])([A-Z])/g, '$1 $2').split(/[_\s]+/);
  const label = parts.join(' ');
  return label.charAt(0).toUpperCase() + label.slice(1);
}
