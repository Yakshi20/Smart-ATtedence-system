import {
  dummyPasswordHash,
  generateOpaqueToken,
  hashOpaqueToken,
  hashPassword,
  verifyPassword,
} from './secrets';

test('passwords hash with argon2id at the configured cost', async () => {
  const stored = await hashPassword('correct horse battery staple');
  expect(stored).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  expect(stored).not.toContain('correct horse');
});

test('verify accepts the right password and rejects a wrong one', async () => {
  const stored = await hashPassword('correct horse battery staple');
  await expect(verifyPassword(stored, 'correct horse battery staple')).resolves.toBe(true);
  await expect(verifyPassword(stored, 'Correct horse battery staple')).resolves.toBe(false);
});

test('a malformed stored hash verifies false instead of throwing', async () => {
  await expect(verifyPassword('not-a-hash', 'anything')).resolves.toBe(false);
});

test('the dummy hash is a real argon2id hash that no guessable input matches', async () => {
  const dummy = await dummyPasswordHash();
  expect(dummy).toMatch(/^\$argon2id\$/);
  await expect(verifyPassword(dummy, '')).resolves.toBe(false);
});

test('opaque tokens are 43 base64url characters and unique', () => {
  const tokens = new Set(Array.from({ length: 200 }, generateOpaqueToken));
  expect(tokens.size).toBe(200);
  for (const t of tokens) expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
});

test('token hashes are 32-byte SHA-256 digests', () => {
  const digest = hashOpaqueToken('abc');
  expect(digest).toHaveLength(32);
  expect(digest.toString('hex')).toBe(
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
});
