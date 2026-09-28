// Sonde utilisée par le HEALTHCHECK Docker (l'image ne contient ni curl ni wget).
const port = Number(process.env.PLUME_HEALTH_PORT ?? 3001);

try {
  const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
    signal: AbortSignal.timeout(3_000),
  });
  process.exit(response.ok ? 0 : 1);
} catch {
  process.exit(1);
}
