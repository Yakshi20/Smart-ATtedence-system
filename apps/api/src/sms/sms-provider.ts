import { Logger } from '@nestjs/common';

/**
 * Outbound SMS, behind an interface so no vendor is baked in (Q4).
 *
 * `send` resolves only when the provider has accepted the message and rejects otherwise.
 * `kind` records what actually happened: `dev_outbox` never reaches a phone, and the OTP
 * challenge row says so. Nothing in the API claims a message was delivered.
 *
 * Adding a real vendor: implement this interface (kind `sms`), add its name to SMS_PROVIDER in
 * config/env.ts, and select it in AppModule. Choosing a paid vendor is the owner's decision.
 */
export interface SmsProvider {
  readonly kind: 'sms' | 'dev_outbox';
  send(to: string, body: string): Promise<void>;
}

export const SMS_PROVIDER = Symbol('SMS_PROVIDER');

export interface OutboxMessage {
  to: string;
  body: string;
  at: Date;
}

/** Masks a phone number for log lines: +91••••••3210. */
export function maskPhone(phone: string): string {
  return `${phone.slice(0, 3)}${'•'.repeat(Math.max(0, phone.length - 7))}${phone.slice(-4)}`;
}

/**
 * Development and test adapter. Messages are held in process memory — never logged, never
 * written to disk, never returned by any HTTP route — and only code holding this instance
 * (the test harness) can read them. Refuses to exist in production.
 */
export class DevOutboxSmsProvider implements SmsProvider {
  readonly kind = 'dev_outbox' as const;
  private readonly logger = new Logger('DevOutboxSms');
  private readonly messages: OutboxMessage[] = [];
  private static readonly CAPACITY = 200;

  constructor(nodeEnv: string) {
    if (nodeEnv === 'production') {
      throw new Error('DevOutboxSmsProvider must not run in production: set SMS_PROVIDER to a real provider or none.');
    }
  }

  async send(to: string, body: string): Promise<void> {
    this.messages.push({ to, body, at: new Date() });
    if (this.messages.length > DevOutboxSmsProvider.CAPACITY) this.messages.shift();
    // Recipient masked, body (which contains the code) never logged.
    this.logger.debug(`message placed in dev outbox for ${maskPhone(to)}`);
  }

  /** Messages for one recipient, oldest first. For tests. */
  messagesFor(to: string): OutboxMessage[] {
    return this.messages.filter((m) => m.to === to);
  }
}
