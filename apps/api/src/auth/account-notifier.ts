import { Logger } from '@nestjs/common';

export interface ActivationMessage {
  userId: string;
  email: string;
  displayName: string;
  /** The plaintext one-time token. Exists only in memory and in the delivered message. */
  token: string;
  expiresAt: Date;
  schoolName: string;
}

/**
 * Delivers account messages out of band.
 *
 * Activation tokens are never returned in an API response — not even to the platform
 * admin who approved the school — because whoever holds one can take over the account.
 * No email provider has been chosen (a paid service; blueprint 00 §8 says to ask first),
 * so this mirrors the Q4 decision for SMS: an interface plus a logging development
 * implementation.
 */
export interface AccountNotifier {
  sendActivation(message: ActivationMessage): Promise<void>;
}

export const ACCOUNT_NOTIFIER = Symbol('ACCOUNT_NOTIFIER');

/**
 * Development-only: writes the activation token to the server log so a developer can
 * complete the flow locally. Refuses to be constructed in production, where the log would
 * become a store of account-takeover tokens.
 */
export class LoggingAccountNotifier implements AccountNotifier {
  private readonly logger = new Logger('AccountNotifier');

  constructor(nodeEnv: string) {
    if (nodeEnv === 'production') {
      throw new Error(
        'LoggingAccountNotifier must not run in production: configure a real email provider.',
      );
    }
  }

  async sendActivation(message: ActivationMessage): Promise<void> {
    this.logger.log(
      `[dev] activation for user ${message.userId} (${message.schoolName}), ` +
        `expires ${message.expiresAt.toISOString()}: token=${message.token}`,
    );
  }
}
