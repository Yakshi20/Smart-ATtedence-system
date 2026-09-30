import { createHash, randomBytes } from 'node:crypto';
import { Algorithm, hash, verify } from '@node-rs/argon2';

/**
 * Credential and token primitives. No cryptography is implemented here — only calls into
 * argon2id and Node's CSPRNG/SHA-256 with fixed, reviewed parameters.
 */

/**
 * OWASP Password Storage Cheat Sheet minimum for argon2id: m=19 MiB, t=2, p=1.
 * The parameters are encoded in each hash, so raising them later only affects new hashes.
 */
const ARGON2_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  try {
    return await verify(storedHash, password);
  } catch {
    // A malformed stored hash is a failed verification, never an error path a caller can
    // distinguish from "wrong password".
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/**
 * A real argon2id hash of a random value, verified against when the account does not exist,
 * so "no such user" costs the same time as "wrong password" and response timing does not
 * reveal which emails have accounts.
 */
export function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(32).toString('base64url'));
  return dummyHash;
}

/** 256 bits from the CSPRNG, base64url without padding (43 characters). */
export function generateOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Storage form of an opaque token. SHA-256 is sufficient because the input is 256 random
 * bits: there is nothing to brute-force, so a slow KDF would only add latency.
 */
export function hashOpaqueToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}
