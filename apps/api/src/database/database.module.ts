import { Global, Module, OnApplicationShutdown, Inject } from '@nestjs/common';
import { createDatabase, type Database, type DatabaseHandle } from '@smart-school/database';
import { CONFIG, type AppConfig } from '../config/env';

export const DATABASE = Symbol('DATABASE');
export const DATABASE_HANDLE = Symbol('DATABASE_HANDLE');

@Global()
@Module({
  providers: [
    {
      provide: DATABASE_HANDLE,
      inject: [CONFIG],
      useFactory: (config: AppConfig): DatabaseHandle => createDatabase(config.DATABASE_URL),
    },
    {
      provide: DATABASE,
      inject: [DATABASE_HANDLE],
      useFactory: (handle: DatabaseHandle): Database => handle.db,
    },
  ],
  exports: [DATABASE, DATABASE_HANDLE],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(DATABASE_HANDLE) private readonly handle: DatabaseHandle) {}

  async onApplicationShutdown(): Promise<void> {
    await this.handle.close();
  }
}
