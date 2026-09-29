import { DynamicModule, Module } from '@nestjs/common';
import { CONFIG, loadConfig, type AppConfig } from './config/env';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';

@Module({})
export class AppModule {
  /**
   * Config is injected rather than read from `process.env` inside providers, so tests can
   * build an app against an isolated database without mutating global state.
   */
  static register(config: AppConfig = loadConfig()): DynamicModule {
    return {
      module: AppModule,
      imports: [DatabaseModule, HealthModule],
      providers: [{ provide: CONFIG, useValue: config }],
      exports: [CONFIG],
      global: true,
    };
  }
}
