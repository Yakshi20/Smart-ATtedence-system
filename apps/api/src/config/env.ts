import { z } from 'zod';

/**
 * Environment schema. Validated once at boot so a misconfigured deployment fails
 * immediately rather than at the first request that happens to need a value.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  JWT_ACCESS_SECRET: z
    .string()
    .min(32, 'JWT_ACCESS_SECRET must be at least 32 characters; generate with `openssl rand -base64 48`'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(600),
  REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(2_592_000),
  ACTIVATION_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().max(1_209_600).default(259_200),

  // Number of reverse-proxy hops in front of the API. Rate limits key on the client IP, so
  // behind a load balancer this must be set or every caller shares the balancer's address.
  // Never set it higher than the real hop count: that lets a client forge its own IP.
  TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(0),

  // SMS delivery for parent OTP login. No paid vendor is chosen (Q4): `dev_outbox` keeps
  // messages in process memory and refuses to start in production; `none` disables OTP login
  // (requests get 503). A real provider is added as a new value here plus an SmsProvider class.
  SMS_PROVIDER: z.enum(['none', 'dev_outbox']).default('dev_outbox'),
  // Key for the HMAC under which OTP codes are stored. Optional: when absent a key is derived
  // from JWT_ACCESS_SECRET with HKDF (domain-separated). Set it explicitly in production.
  OTP_HASH_SECRET: z.string().min(32, 'OTP_HASH_SECRET must be at least 32 characters').optional(),
  OTP_TTL_SECONDS: z.coerce.number().int().min(60).max(900).default(300),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),

  // Attendance date policy. "Today" is computed by the database in this IANA timezone, so a
  // register opened at 00:30 IST is not rejected as a future date by a UTC server.
  ATTENDANCE_TIMEZONE: z
    .string()
    .refine((tz) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, 'ATTENDANCE_TIMEZONE must be an IANA timezone such as Asia/Kolkata')
    .default('Asia/Kolkata'),
  // How many days back a teacher may open or submit a register. School admins may use any date
  // in the active academic year. Future dates are never accepted.
  ATTENDANCE_TEACHER_BACKDATE_DAYS: z.coerce.number().int().min(0).max(60).default(7),
});

export type AppConfig = Readonly<z.infer<typeof EnvSchema>>;

export class ConfigError extends Error {
  constructor(issues: string[]) {
    super(`Invalid environment configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }
  return Object.freeze(result.data);
}

export const CONFIG = Symbol('APP_CONFIG');
