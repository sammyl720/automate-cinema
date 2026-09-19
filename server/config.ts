import { z } from 'zod';
import { resolve } from 'node:path';
const parsed = z
  .object({
    TYPESAFE_API_KEY: z.string().default(''),
    TYPESAFE_MODEL: z.string().trim().min(1).max(100).default('jev-latest'),
    TYPESAFE_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1000)
      .max(120000)
      .default(30000),
    TYPESAFE_INPUT_USD_PER_MILLION: z.coerce.number().positive().default(0.042),
    JEV_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.7),
    JEV_MIN_STRONG_PROBABILITY: z.coerce.number().min(0).max(1).default(0.75),
    JEV_PREFLIGHT_MIN_SCORE: z.coerce.number().min(0).max(100).default(70),
    JEV_CONTINUITY_MIN_PROBABILITY: z.coerce
      .number()
      .min(0)
      .max(1)
      .default(0.7),
    JEV_AMBIGUITY_MAX_PROBABILITY: z.coerce.number().min(0).max(1).default(0.3),
    OPENAI_API_KEY: z.string().default(''),
    ELEVENLABS_API_KEY: z.string().default(''),
    ELEVENLABS_TTS_USD_PER_1000: z.coerce.number().positive().default(0.1),
    ELEVENLABS_MUSIC_USD_PER_MINUTE: z.coerce.number().positive().default(0.15),
    RUNWAY_API_KEY: z.string().default(''),
    OPENAI_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1000)
      .max(150000)
      .default(90000),
    STUDIO_HOST: z.string().default('127.0.0.1'),
    STUDIO_PORT: z.coerce.number().int().min(1024).max(65535).default(4311),
    STUDIO_DATA_DIR: z.string().default('./data'),
    STUDIO_TOKEN: z.string().default(''),
    STUDIO_ORIGIN: z.url().default('http://localhost:3001'),
    FFMPEG_PATH: z.string().default('ffmpeg'),
    FFPROBE_PATH: z.string().default('ffprobe'),
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
    JOB_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1000)
      .max(1800000)
      .default(180000),
  })
  .parse(process.env);
if (
  !['localhost', '127.0.0.1', '::1'].includes(parsed.STUDIO_HOST) &&
  parsed.STUDIO_TOKEN.length < 32
)
  throw new Error(
    'A STUDIO_TOKEN of at least 32 characters is required for non-loopback hosts.',
  );
export const config = { ...parsed, dataDir: resolve(parsed.STUDIO_DATA_DIR) };
