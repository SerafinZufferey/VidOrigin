import 'dotenv/config';
import {z} from 'zod';

const env=z.object({
  PUBLIC_BASE_URL:z.string().url().refine(value=>value.startsWith('https://')||value.startsWith('http://localhost:')),
  DEVVIT_SHARED_SECRET:z.string().min(32),
  GOOGLE_CLOUD_VISION_API_KEY:z.string().min(20).optional(),
  EXTERNAL_GIF_HOSTS:z.string().default(''),
  PORT:z.coerce.number().int().min(1).max(65535).default(8080),
  SESSION_TTL_MINUTES:z.coerce.number().int().min(5).max(1440).default(60),
  MAX_VIDEO_BYTES:z.coerce.number().int().min(1_000_000).default(104_857_600),
  MAX_VIDEO_DURATION_SECONDS:z.coerce.number().positive().default(600),
  MAX_IMAGE_BYTES:z.coerce.number().int().min(1_000_000).default(26_214_400),
  MAX_GALLERY_IMAGES:z.coerce.number().int().min(1).max(50).default(20),
  MAX_IMAGE_PIXELS:z.coerce.number().int().min(1_000_000).default(50_000_000),
  MAX_CONCURRENT_JOBS:z.coerce.number().int().min(1).max(8).default(2),
  RATE_LIMIT_PER_MINUTE:z.coerce.number().int().min(1).default(20),
  DATA_DIR:z.string().default('./data'),
  FFMPEG_PATH:z.string().default('ffmpeg'),
  FFPROBE_PATH:z.string().default('ffprobe'),
  TRUST_PROXY:z.coerce.number().int().min(0).max(2).default(1),
  LOG_LEVEL:z.string().default('info')
}).parse(process.env);

export const config={...env,publicBaseUrl:env.PUBLIC_BASE_URL.replace(/\/$/,'')};
