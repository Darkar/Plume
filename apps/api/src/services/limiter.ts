import type { Redis } from 'ioredis';

const PREFIX = 'plume:rl:';

/**
 * Limitation de débit par fenêtre fixe dans Redis, et verrouillage temporaire des comptes.
 * Les limites sont lues à chaque appel : elles suivent le rechargement à chaud de la configuration.
 */
export class Limiter {
  constructor(private readonly redis: Redis) {}

  /** Incrémente le compteur et indique si la limite est dépassée. */
  async hit(scope: string, key: string, max: number, windowMs: number): Promise<boolean> {
    const redisKey = `${PREFIX}${scope}:${key}`;
    const [[, count]] = (await this.redis
      .multi()
      .incr(redisKey)
      .pexpire(redisKey, windowMs, 'NX')
      .exec()) as [[unknown, number], [unknown, number]];
    return count > max;
  }

  async isLocked(account: string): Promise<boolean> {
    return (await this.redis.exists(`${PREFIX}lock:${account}`)) === 1;
  }

  /**
   * Enregistre un échec de connexion pour un compte. Au-delà de `max` échecs dans la fenêtre,
   * le compte est verrouillé pendant `lockoutMs`. Renvoie true si le compte vient d'être verrouillé.
   */
  async recordFailure(
    account: string,
    limits: { max: number; window: number; lockout: number },
  ): Promise<boolean> {
    const exceeded = await this.hit('fail', account, limits.max - 1, limits.window);
    if (!exceeded) return false;
    await this.redis
      .multi()
      .set(`${PREFIX}lock:${account}`, '1', 'PX', limits.lockout)
      .del(`${PREFIX}fail:${account}`)
      .exec();
    return true;
  }

  async reset(account: string): Promise<void> {
    await this.redis.del(`${PREFIX}fail:${account}`);
  }
}
