import dns from 'node:dns/promises';
import net from 'node:net';

export type UrlPolicy = {
  /**
   * Loopback and private ranges are allowed for a URL the caller named — a
   * local dev server is a legitimate thing to fetch from a tool running on your
   * own machine — but never for a *redirect* target, which the caller did not
   * choose and which is how a page walks a fetcher into the LAN.
   */
  allowPrivate: boolean;
};

export class BlockedUrlError extends Error {}

/** Checked on the initial URL and again on every redirect hop. */
export async function assertUrlAllowed(rawUrl: string, policy: UrlPolicy): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BlockedUrlError(`Not a valid URL: ${rawUrl}`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new BlockedUrlError(`Refusing to fetch a "${url.protocol}" URL; only http and https are allowed.`);

  const addresses = await resolveHost(url.hostname);
  for (const address of addresses) {
    const kind = classify(address);
    if (kind === 'link-local')
      throw new BlockedUrlError(`Refusing to fetch ${url.hostname} (${address}): link-local addresses serve cloud instance metadata.`);
    if (kind === 'blocked')
      throw new BlockedUrlError(`Refusing to fetch ${url.hostname} (${address}).`);
    if (kind === 'private' && !policy.allowPrivate)
      throw new BlockedUrlError(`Refusing to follow a redirect to a private address (${url.hostname} -> ${address}).`);
  }
  return url;
}

async function resolveHost(hostname: string): Promise<string[]> {
  const literal = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;
  if (net.isIP(literal))
    return [literal];
  try {
    const records = await dns.lookup(hostname, { all: true, verbatim: true });
    return records.map(r => r.address);
  } catch {
    // A name that does not resolve fails at connect time with a clearer error.
    return [];
  }
}

type Kind = 'public' | 'private' | 'link-local' | 'blocked';

function classify(address: string): Kind {
  if (net.isIPv4(address))
    return classifyIPv4(address);
  if (net.isIPv6(address))
    return classifyIPv6(address);
  return 'blocked';
}

function classifyIPv4(address: string): Kind {
  const [a, b] = address.split('.').map(Number);
  if (a === 169 && b === 254)
    return 'link-local';
  if (a === 127 || a === 10 || a === 0)
    return 'private';
  if (a === 172 && b >= 16 && b <= 31)
    return 'private';
  if (a === 192 && b === 168)
    return 'private';
  if (a === 100 && b >= 64 && b <= 127)
    return 'private';
  if (a === 192 && b === 0)
    return 'private';
  if (a >= 224)
    return 'blocked';
  return 'public';
}

function classifyIPv6(address: string): Kind {
  const lower = address.toLowerCase();
  if (lower === '::1' || lower === '::')
    return 'private';
  // IPv4-mapped, e.g. ::ffff:127.0.0.1
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped)
    return classifyIPv4(mapped[1]);
  if (lower.startsWith('fe80') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb'))
    return 'link-local';
  // Unique local fc00::/7
  if (/^f[cd]/.test(lower))
    return 'private';
  if (lower.startsWith('ff'))
    return 'blocked';
  return 'public';
}
