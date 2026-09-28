import { Redis, type RedisOptions } from 'ioredis';

export function createRedis(url: string, options: RedisOptions = {}): Redis {
  return new Redis(url, {
    lazyConnect: false,
    enableAutoPipelining: true,
    maxRetriesPerRequest: 3,
    connectTimeout: 5_000,
    ...options,
  });
}

export type { Redis };
