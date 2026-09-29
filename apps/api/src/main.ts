import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { createApp } from './bootstrap';
import { ConfigError, loadConfig } from './config/env';

async function main(): Promise<void> {
  const logger = new Logger('bootstrap');

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    // Configuration problems are operator errors: print them plainly and stop.
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(2);
    }
    throw err;
  }

  const app = await createApp(config);
  await app.listen(config.API_PORT);
  logger.log(`API listening on port ${config.API_PORT} (${config.NODE_ENV})`);
}

void main();
