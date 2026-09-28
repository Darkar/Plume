import { readSecret, type DomainConfig } from '@plume/config';
import type { ConnectionOptions } from 'node:tls';

export interface ServerTarget {
  host: string;
  port: number;
  security: 'tls' | 'starttls';
  tls: { reject_unauthorized: boolean; min_version: 'TLSv1.2' | 'TLSv1.3' };
}

/** Serveur IMAP ou SMTP d'un domaine de la liste blanche (jamais choisi par l'utilisateur). */
export function serverFor(domain: DomainConfig, protocol: 'imap' | 'smtp'): ServerTarget {
  const { host, port, security } = domain[protocol];
  return { host, port, security, tls: domain.tls };
}

/** Identifiant de connexion transmis au serveur selon la configuration du domaine. */
export function loginFor(domain: DomainConfig, address: string): string {
  return domain.login_format === 'local_part' ? (address.split('@')[0] as string) : address;
}

export interface SmtpLogin {
  user: string;
  pass: string;
  /** Relais commun du domaine : un refus d'authentification n'est pas imputable à l'utilisateur. */
  relay: boolean;
}

/**
 * Identifiants d'envoi : ceux du relais SMTP commun au domaine s'il est configuré (secret relu à
 * chaque appel, pour suivre une rotation sans redémarrage), sinon ceux de la boîte.
 */
export function smtpLoginFor(
  domain: DomainConfig,
  address: string,
  mailboxPassword: string,
  env: NodeJS.ProcessEnv = process.env,
): SmtpLogin {
  const relay = domain.smtp.auth;
  if (relay) return { user: relay.username, pass: readSecret(relay.password, env), relay: true };
  return { user: loginFor(domain, address), pass: mailboxPassword, relay: false };
}

export function tlsOptions(target: ServerTarget): ConnectionOptions {
  return {
    servername: /^[\d.:]+$/.test(target.host) ? undefined : target.host,
    rejectUnauthorized: target.tls.reject_unauthorized,
    minVersion: target.tls.min_version,
  };
}
