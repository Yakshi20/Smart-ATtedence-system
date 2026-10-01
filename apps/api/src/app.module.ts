import { DynamicModule, Module } from '@nestjs/common';
import { AcademicModule } from './academic/academic.module';
import { AccessModule } from './access/access.module';
import { AttendanceModule } from './attendance/attendance.module';
import {
  ACCOUNT_NOTIFIER,
  LoggingAccountNotifier,
  type AccountNotifier,
} from './auth/account-notifier';
import { AuthModule } from './auth/auth.module';
import {
  DEFAULT_RATE_LIMIT_RULES,
  RATE_LIMIT_RULES,
  RateLimiter,
  type RateLimitRules,
} from './common/rate-limiter';
import { CONFIG, loadConfig, type AppConfig } from './config/env';
import { DatabaseModule } from './database/database.module';
import { GuardiansModule } from './guardians/guardians.module';
import { HealthModule } from './health/health.module';
import { MeModule } from './me/me.module';
import { RegistrationModule } from './registration/registration.module';
import { ReportsModule } from './reports/reports.module';
import { SchoolsModule } from './schools/schools.module';
import { DevOutboxSmsProvider, SMS_PROVIDER, type SmsProvider } from './sms/sms-provider';

/**
 * Collaborators a test may substitute. Production passes none of these; there is no
 * environment variable that can swap them, so they cannot be changed in a deployment.
 */
export interface AppOverrides {
  accountNotifier?: AccountNotifier;
  rateLimitRules?: Partial<RateLimitRules>;
  /** `null` simulates SMS_PROVIDER=none. */
  smsProvider?: SmsProvider | null;
}

function smsProviderFor(config: AppConfig): SmsProvider | null {
  switch (config.SMS_PROVIDER) {
    case 'dev_outbox':
      return new DevOutboxSmsProvider(config.NODE_ENV);
    case 'none':
      return null;
  }
}

@Module({})
export class AppModule {
  /**
   * Config is injected rather than read from `process.env` inside providers, so tests can
   * build an app against an isolated database without mutating global state.
   */
  static register(config: AppConfig = loadConfig(), overrides: AppOverrides = {}): DynamicModule {
    const rules: RateLimitRules = { ...DEFAULT_RATE_LIMIT_RULES, ...overrides.rateLimitRules };

    return {
      module: AppModule,
      imports: [
        DatabaseModule,
        HealthModule,
        AccessModule,
        AuthModule,
        MeModule,
        RegistrationModule,
        SchoolsModule,
        AcademicModule,
        GuardiansModule,
        AttendanceModule,
        ReportsModule,
      ],
      providers: [
        { provide: CONFIG, useValue: config },
        { provide: RATE_LIMIT_RULES, useValue: rules },
        { provide: RateLimiter, useValue: new RateLimiter(rules) },
        {
          provide: SMS_PROVIDER,
          useValue: overrides.smsProvider !== undefined ? overrides.smsProvider : smsProviderFor(config),
        },
        {
          provide: ACCOUNT_NOTIFIER,
          useValue: overrides.accountNotifier ?? new LoggingAccountNotifier(config.NODE_ENV),
        },
      ],
      exports: [CONFIG, RATE_LIMIT_RULES, RateLimiter, ACCOUNT_NOTIFIER, SMS_PROVIDER],
      global: true,
    };
  }
}
