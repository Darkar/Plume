import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { isIP, type LookupFunction } from 'node:net';
import ipaddr from 'ipaddr.js';
import { Agent, request } from 'undici';

/**
 * Récupération d'images distantes pour le proxy, protégée contre la SSRF :
 * - schémas http/https et ports 80/443 uniquement, pas d'identifiants dans l'URL ;
 * - toute adresse non publique est refusée (boucle locale, privées, lien local, métadonnées
 *   cloud 169.254.169.254, CGNAT, multidiffusion, IPv6 locales, IPv4 encapsulées…) ;
 * - la vérification porte sur l'adresse effectivement utilisée pour la connexion (résolution
 *   « épinglée ») : un rebinding DNS entre vérification et connexion est impossible ;
 * - redirections suivies manuellement (3 au plus), chacune revérifiée ;
 * - taille et durée limitées, type d'image vérifié par signature (SVG refusé).
 */

export class SafeFetchError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'SafeFetchError';
  }
}

export type AddressPolicy = (address: string) => boolean;

/** Seules les adresses « unicast » globales sont autorisées. */
export function isPublicAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return false;
  let parsed = ipaddr.parse(address);
  if (parsed.kind() === 'ipv6') {
    const v6 = parsed as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) parsed = v6.toIPv4Address();
  }
  return parsed.range() === 'unicast';
}

export interface SafeFetchOptions {
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  /** Pour les tests uniquement : politique d'adresses et résolveur DNS. */
  addressPolicy?: AddressPolicy;
  lookup?: typeof dnsLookup;
  allowedPorts?: ReadonlySet<string>;
}

export interface FetchedImage {
  contentType: string;
  body: Buffer;
}

const DEFAULTS = { maxBytes: 5 * 1024 * 1024, timeoutMs: 10_000, maxRedirects: 3 };
const ALLOWED_PORTS = new Set(['', '80', '443']);

/** Signatures des formats d'image acceptés (le type annoncé par le serveur n'est pas fiable). */
export function sniffImageType(body: Buffer): string | null {
  const startsWith = (bytes: number[], offset = 0) =>
    bytes.every((byte, i) => body[offset + i] === byte);
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith([0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  if (startsWith([0x52, 0x49, 0x46, 0x46]) && startsWith([0x57, 0x45, 0x42, 0x50], 8)) {
    return 'image/webp';
  }
  if (startsWith([0x42, 0x4d])) return 'image/bmp';
  if (startsWith([0x00, 0x00, 0x01, 0x00])) return 'image/x-icon';
  if (startsWith([0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66], 4)) return 'image/avif';
  return null;
}

function checkedLookup(policy: AddressPolicy, resolver: typeof dnsLookup): LookupFunction {
  return (hostname, options, callback) => {
    resolver(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) return callback(error, '', 0);
      const list = (Array.isArray(addresses) ? addresses : []) as LookupAddress[];
      // Toutes les adresses doivent être publiques : sinon un attaquant pourrait panacher.
      if (list.length === 0 || !list.every((entry) => policy(entry.address))) {
        return callback(new SafeFetchError('forbidden_address'), '', 0);
      }
      const chosen = list[0] as LookupAddress;
      if ((options as { all?: boolean }).all) {
        return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
      }
      return callback(null, chosen.address, chosen.family);
    });
  };
}

export function validateTarget(
  raw: string,
  policy: AddressPolicy = isPublicAddress,
  ports: ReadonlySet<string> = ALLOWED_PORTS,
): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SafeFetchError('invalid_url');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SafeFetchError('forbidden_scheme');
  }
  if (url.username || url.password) throw new SafeFetchError('credentials_in_url');
  if (!ports.has(url.port)) throw new SafeFetchError('forbidden_port');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) !== 0 && !policy(host)) throw new SafeFetchError('forbidden_address');
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    (!host.includes('.') && isIP(host) === 0)
  ) {
    throw new SafeFetchError('forbidden_address');
  }
  return url;
}

export async function safeFetchImage(
  raw: string,
  options: SafeFetchOptions = {},
): Promise<FetchedImage> {
  const { maxBytes, timeoutMs, maxRedirects } = { ...DEFAULTS, ...options };
  const policy = options.addressPolicy ?? isPublicAddress;
  const agent = new Agent({
    connect: { lookup: checkedLookup(policy, options.lookup ?? dnsLookup), timeout: timeoutMs },
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
    connections: 1,
  });
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const ports = options.allowedPorts ?? ALLOWED_PORTS;
    let url = validateTarget(raw, policy, ports);
    for (let hop = 0; ; hop++) {
      const response = await request(url, {
        dispatcher: agent,
        method: 'GET',
        signal,
        headers: {
          accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.1',
          'user-agent': 'Mozilla/5.0 (compatible; Plume-Image-Proxy)',
        },
      }).catch((error: unknown) => {
        const cause = (error as { cause?: unknown }).cause;
        if (error instanceof SafeFetchError) throw error;
        if (cause instanceof SafeFetchError) throw cause;
        throw new SafeFetchError(signal.aborted ? 'timeout' : 'network_error');
      });

      if (response.statusCode >= 300 && response.statusCode < 400) {
        await response.body.dump();
        const location = response.headers.location;
        if (typeof location !== 'string' || hop >= maxRedirects) {
          throw new SafeFetchError('too_many_redirects');
        }
        url = validateTarget(new URL(location, url).toString(), policy, ports);
        continue;
      }
      if (response.statusCode !== 200) {
        await response.body.dump();
        throw new SafeFetchError('upstream_status');
      }
      const declared = Number(response.headers['content-length'] ?? 0);
      if (declared > maxBytes) {
        await response.body.dump();
        throw new SafeFetchError('too_large');
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += (chunk as Buffer).length;
        if (size > maxBytes) {
          response.body.destroy();
          throw new SafeFetchError('too_large');
        }
        chunks.push(chunk as Buffer);
      }
      const body = Buffer.concat(chunks);
      const contentType = sniffImageType(body);
      if (!contentType) throw new SafeFetchError('not_an_image');
      return { contentType, body };
    }
  } finally {
    await agent.close().catch(() => undefined);
  }
}
