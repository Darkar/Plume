import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const FORMAT_VERSION = 'v1';
const HKDF_SALT = Buffer.from('plume/credentials/salt/v1');

export class CryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CryptoError';
  }
}

/**
 * Décode la clé maître (base64 de 32 octets, ou 64 caractères hexadécimaux).
 * Toute autre forme est refusée : une clé faible ne doit jamais être acceptée silencieusement.
 */
export function parseMasterKey(encoded: string): Buffer {
  const value = encoded.trim();
  let key: Buffer | null = null;
  if (/^[0-9a-f]{64}$/i.test(value)) {
    key = Buffer.from(value, 'hex');
  } else if (/^[A-Za-z0-9+/]{43}=?$/.test(value)) {
    key = Buffer.from(value, 'base64');
  }
  if (!key || key.length !== KEY_BYTES) {
    throw new CryptoError('clé maître invalide : 32 octets attendus (base64 ou hexadécimal)');
  }
  if (key.every((byte) => byte === key[0])) {
    throw new CryptoError('clé maître invalide : octets tous identiques');
  }
  return key;
}

/** Identifiant court et non secret d'une clé maître (permet de détecter une rotation). */
export function keyId(masterKey: Buffer): string {
  return createHmac('sha256', masterKey).update('plume/key-id').digest('base64url').slice(0, 12);
}

/**
 * Chiffre des secrets par utilisateur : clé dérivée par HKDF-SHA256 à partir de la clé maître et
 * de l'identifiant de l'utilisateur, AES-256-GCM avec IV aléatoire. L'identifiant de l'utilisateur
 * et le « contexte » sont aussi liés comme données authentifiées : une valeur copiée vers un autre
 * utilisateur ou un autre usage est rejetée.
 *
 * Format : `v1.<keyId>.<iv>.<chiffré>.<tag>` (base64url).
 */
export class SecretBox {
  readonly keyId: string;
  readonly #master: Buffer;

  constructor(masterKey: Buffer) {
    if (masterKey.length !== KEY_BYTES) throw new CryptoError('clé maître de 32 octets requise');
    this.#master = Buffer.from(masterKey);
    this.keyId = keyId(this.#master);
  }

  #derive(userId: string, context: string): Buffer {
    const info = Buffer.from(`plume/${context}/${userId}`);
    return Buffer.from(hkdfSync('sha256', this.#master, HKDF_SALT, info, KEY_BYTES));
  }

  #aad(userId: string, context: string): Buffer {
    return Buffer.from(`${FORMAT_VERSION}|${context}|${userId}`);
  }

  encrypt(userId: string, context: string, plaintext: string): string {
    if (!userId || !context) throw new CryptoError('utilisateur et contexte requis');
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.#derive(userId, context), iv, {
      authTagLength: TAG_BYTES,
    });
    cipher.setAAD(this.#aad(userId, context));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      FORMAT_VERSION,
      this.keyId,
      iv.toString('base64url'),
      ciphertext.toString('base64url'),
      tag.toString('base64url'),
    ].join('.');
  }

  decrypt(userId: string, context: string, payload: string): string {
    const parts = payload.split('.');
    if (parts.length !== 5 || parts[0] !== FORMAT_VERSION) {
      throw new CryptoError('format de données chiffrées inconnu');
    }
    const [, kid, ivText, ctText, tagText] = parts as [string, string, string, string, string];
    if (kid !== this.keyId) throw new CryptoError('données chiffrées avec une autre clé maître');
    const iv = Buffer.from(ivText, 'base64url');
    const tag = Buffer.from(tagText, 'base64url');
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
      throw new CryptoError('données chiffrées corrompues');
    }
    try {
      const decipher = createDecipheriv(ALGORITHM, this.#derive(userId, context), iv, {
        authTagLength: TAG_BYTES,
      });
      decipher.setAAD(this.#aad(userId, context));
      decipher.setAuthTag(tag);
      return Buffer.concat([
        decipher.update(Buffer.from(ctText, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      // Ne jamais exposer le détail (oracle) : altération, mauvais utilisateur ou mauvaise clé.
      throw new CryptoError('échec de l’authentification des données chiffrées');
    }
  }

  /** Indique si une valeur a été chiffrée avec cette clé (utile pour la rotation). */
  isCurrent(payload: string): boolean {
    return payload.split('.')[1] === this.keyId;
  }
}

/** Jeton aléatoire encodé en base64url (256 bits par défaut). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Comparaison en temps constant de deux chaînes. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    // On compare quand même pour ne pas révéler la longueur par le temps d'exécution.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

/** HMAC-SHA256 encodé en base64url (signature d'URL, empreintes d'identifiants). */
export function hmac(key: Buffer | string, data: string): string {
  return createHmac('sha256', key).update(data).digest('base64url');
}
