import type { IssuedTokens } from '../auth/session.service';
import { DevOutboxSmsProvider, type SmsProvider } from '../sms/sms-provider';
import type { TestApp } from './app-harness';
import { http } from './identity-fixtures';

/** Dev outbox plus a switch to simulate a provider outage. */
export class TestSms implements SmsProvider {
  readonly kind = 'dev_outbox' as const;
  readonly outbox = new DevOutboxSmsProvider('test');
  fail = false;

  async send(to: string, body: string): Promise<void> {
    if (this.fail) throw new Error('simulated provider outage');
    await this.outbox.send(to, body);
  }

  /** The code from the most recent message to `phone`. */
  lastCode(phone: string): string {
    const messages = this.outbox.messagesFor(phone);
    const body = messages[messages.length - 1]?.body;
    const code = body ? /^(\d{6}) /.exec(body)?.[1] : undefined;
    if (!code) throw new Error(`no code was sent to ${phone}`);
    return code;
  }

  count(phone: string): number {
    return this.outbox.messagesFor(phone).length;
  }
}

export function requestOtp(t: TestApp, phone: string) {
  return http(t).post('/api/v1/auth/otp/request').send({ phone });
}

export function verifyOtp(t: TestApp, phone: string, code: string) {
  return http(t).post('/api/v1/auth/otp/verify').send({ phone, code });
}

/** Full parent login: request a code, read it from the outbox, exchange it for tokens. */
export async function otpLogin(t: TestApp, sms: TestSms, phone: string): Promise<IssuedTokens> {
  const req = await requestOtp(t, phone);
  if (req.status !== 202) throw new Error(`otp request failed: ${req.status} ${JSON.stringify(req.body)}`);
  const res = await verifyOtp(t, phone, sms.lastCode(phone));
  if (res.status !== 200) throw new Error(`otp verify failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as IssuedTokens;
}

/** Unique valid Indian mobile numbers per test run. */
let n = 0;
export function newPhone(): string {
  n += 1;
  return `+919${String(Date.now() % 1_000_000).padStart(6, '0')}${String(n).padStart(3, '0')}`;
}
