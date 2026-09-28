import { hkdfSync } from 'node:crypto';
import { hmac, safeEqual } from '@plume/crypto';

/**
 * Signature d'URL (HMAC-SHA256) pour les ressources chargées depuis l'iframe isolée du corps des
 * mails : cette iframe a une origine opaque et n'envoie pas le cookie de session (SameSite=Strict).
 * La signature lie les paramètres et une date d'expiration.
 */
export class UrlSigner {
  readonly #key: Buffer;

  constructor(masterKey: Buffer) {
    this.#key = Buffer.from(
      hkdfSync(
        'sha256',
        masterKey,
        Buffer.from('plume/url-signing/salt'),
        Buffer.from('plume/url-signing/v1'),
        32,
      ),
    );
  }

  sign(scope: string, values: string[], expiresAt: number): string {
    // Sérialisation JSON : aucune ambiguïté de concaténation entre valeurs.
    return hmac(this.#key, JSON.stringify([scope, expiresAt, ...values]));
  }

  verify(
    scope: string,
    values: string[],
    expiresAt: number,
    signature: string,
    now = Date.now(),
  ): boolean {
    if (!Number.isSafeInteger(expiresAt) || expiresAt < now) return false;
    if (!/^[A-Za-z0-9_-]{43}$/.test(signature)) return false;
    return safeEqual(this.sign(scope, values, expiresAt), signature);
  }
}
