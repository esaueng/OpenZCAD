/**
 * The client address a per-address limit keys on. An IPv4 address is used as
 * is. An IPv6 address is reduced to its /64 prefix: a single subscriber is
 * usually handed a whole /64, so keying on the full address would give one
 * client as many buckets as it has addresses to choose from. An IPv4-mapped
 * IPv6 address keys as its IPv4 address. Anything that does not parse is
 * used verbatim.
 */
export function clientAddressKey(value: string | null | undefined): string {
  const address = value?.trim() || 'unknown';
  if (!address.includes(':')) return address;
  const groups = ipv6Groups(address.split('%')[0]!.toLowerCase());
  if (!groups) return address;
  if (
    groups.slice(0, 5).every((group) => group === 0) &&
    groups[5] === 0xffff
  ) {
    return [
      groups[6]! >> 8,
      groups[6]! & 0xff,
      groups[7]! >> 8,
      groups[7]! & 0xff
    ].join('.');
  }
  return `${groups
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(':')}::/64`;
}

/** The client address of a request, keyed as `clientAddressKey` does. */
export function requestClientAddressKey(request: Request): string {
  return clientAddressKey(request.headers.get('cf-connecting-ip'));
}

/** The eight 16-bit groups of a textual IPv6 address, or null. */
function ipv6Groups(text: string): number[] | null {
  let value = text;
  // A trailing dotted IPv4 part stands for the last two groups.
  const dotted = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (dotted) {
    const octets = dotted.slice(1).map(Number);
    if (octets.some((octet) => octet > 255)) return null;
    value =
      value.slice(0, dotted.index) +
      `${((octets[0]! << 8) | octets[1]!).toString(16)}:${(
        (octets[2]! << 8) |
        octets[3]!
      ).toString(16)}`;
  }
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const split = (part: string) => (part === '' ? [] : part.split(':'));
  const head = split(halves[0]!);
  const tail = halves.length === 2 ? split(halves[1]!) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const parts = [...head, ...Array<string>(missing).fill('0'), ...tail];
  if (!parts.every((part) => /^[0-9a-f]{1,4}$/.test(part))) return null;
  return parts.map((part) => parseInt(part, 16));
}
