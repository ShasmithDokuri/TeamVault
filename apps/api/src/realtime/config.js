function readRealtimeConfig(env = process.env) {
  const redisUrl = env.REDIS_URL?.trim() || null;
  if (redisUrl) {
    let parsed;
    try { parsed = new URL(redisUrl); } catch { throw new Error('REDIS_URL must be a valid Redis connection URL.'); }
    if (!['redis:', 'rediss:'].includes(parsed.protocol) || !parsed.hostname) {
      throw new Error('REDIS_URL must use redis:// or rediss:// and include a host.');
    }
  }
  return Object.freeze({ redisUrl, enabled: Boolean(redisUrl) });
}

module.exports = { readRealtimeConfig };
