/**
 * Shared private/internal-network detection for outbound AI endpoints.
 *
 * Both the settings save path and the request-time provider dispatch guard
 * the same SSRF surface; before this module each kept its own copy with
 * slightly different coverage (`.lan` only in one, NAT64 only in the other).
 * This is the fail-closed union of both. Callers own any development-mode
 * exceptions — nothing here is environment-aware.
 */

export function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) {
    return false;
  }
  const octets = parts.map(Number);
  // A malformed dotted quad reads as private rather than public.
  if (octets.some((octet) => octet > 255)) {
    return true;
  }
  const [first, second] = octets as [number, number, number, number];
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    // Carrier-grade NAT space.
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    // Multicast and reserved.
    first >= 224
  );
}

export function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.lan') ||
    isPrivateIpv4(host)
  ) {
    return true;
  }
  if (!host.includes(':')) {
    return false;
  }
  return (
    host === '::' ||
    host === '::1' ||
    /^(?:fc|fd|fe[89ab])/i.test(host) ||
    // IPv4-mapped and NAT64 prefixes tunnel private IPv4 targets through the
    // IPv6 grammar; no legitimate public provider uses them, so block all.
    host.startsWith('::ffff:') ||
    host.startsWith('64:ff9b::')
  );
}
