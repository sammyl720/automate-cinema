import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
if (existsSync('.env')) process.loadEnvFile('.env');
const { seed } = await import('../server/seed');
const { createApi } = await import('../server/index');
const { startWorker } = await import('../server/worker');
const { config } = await import('../server/config');
seed();
const server = createApi();
server.listen(config.STUDIO_PORT, config.STUDIO_HOST, () =>
  console.log(`Studio API: http://${config.STUDIO_HOST}:${config.STUDIO_PORT}`),
);
const stop = startWorker();
const frontend = spawn('npm', ['run', 'dev'], {
  stdio: 'inherit',
  env: process.env,
});
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  frontend.kill('SIGTERM');
  await stop();
  server.close(() => process.exit(0));
}
frontend.on('exit', () => void close());
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => void close());
