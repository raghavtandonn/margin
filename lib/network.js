import { BlockList, isIP } from 'node:net';

const normalise = ip => String(ip || '').startsWith('::ffff:') && isIP(String(ip).slice(7)) === 4
  ? String(ip).slice(7) : String(ip || '');

/** Exact IPs or CIDRs; a textual prefix is not a network boundary. */
export function addressAllowlist(entries) {
  const list = new BlockList();
  for (const entry of entries) {
    const [address, prefix, extra] = entry.split('/');
    const ip = normalise(address);
    const family = isIP(ip);
    if (!family || extra !== undefined) throw new Error('Invalid staff network allowlist.');
    const type = family === 4 ? 'ipv4' : 'ipv6';
    if (prefix === undefined) list.addAddress(ip, type);
    else {
      const bits = Number(prefix);
      if (!/^\d+$/.test(prefix) || bits > (family === 4 ? 32 : 128)) throw new Error('Invalid staff network prefix.');
      list.addSubnet(ip, bits, type);
    }
  }
  return address => {
    const ip = normalise(address);
    const family = isIP(ip);
    return !!family && list.check(ip, family === 4 ? 'ipv4' : 'ipv6');
  };
}
