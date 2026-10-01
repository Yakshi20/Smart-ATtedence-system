import { DevOutboxSmsProvider, maskPhone } from './sms-provider';

test('the dev outbox refuses to exist in production', () => {
  expect(() => new DevOutboxSmsProvider('production')).toThrow(/must not run in production/);
  expect(() => new DevOutboxSmsProvider('development')).not.toThrow();
});

test('the dev outbox holds messages in memory only, per recipient', async () => {
  const outbox = new DevOutboxSmsProvider('test');
  await outbox.send('+919845012345', '123456 is your code');
  expect(outbox.messagesFor('+919845012345')).toHaveLength(1);
  expect(outbox.messagesFor('+919800000000')).toEqual([]);
});

test('masked phones keep only the country code and last four digits', () => {
  expect(maskPhone('+919845012345')).toBe('+91••••••2345');
  expect(maskPhone('+919845012345')).not.toContain('98450');
});
