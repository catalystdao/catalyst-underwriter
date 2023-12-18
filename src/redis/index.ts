import { Redis } from 'ioredis';

export class RedisStore {
  readonly redis: Redis;

  constructor() {
    const port: number = Number(process.env.REDIS_PORT);
    if (!port) throw new Error('REDIS_PORT env variable is missing');

    this.redis = new Redis(
      port,
      process.env.USE_DOCKER ? 'redis' : 'localhost',
    );
  }

  async get(key: string) {
    return this.redis.get(key);
  }

  async set(key: string, value: string) {
    await this.redis.set(key, value);
  }

  async del(key: string) {
    await this.redis.del(key);
  }
}
