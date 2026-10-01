import { randomInt } from 'node:crypto';

/**
 * Omits 0/O, 1/I/L so a code read aloud over the phone or copied from paper is unambiguous.
 * 31 symbols over 8 positions ≈ 8.5 × 10¹¹ codes; collisions are handled by retry on the
 * unique constraint, not by probability.
 */
export const SCHOOL_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const SCHOOL_CODE_LENGTH = 8;

/**
 * School codes are identifiers, not secrets (non-negotiable 8) — they appear on printed
 * login cards. They are random rather than sequential only so they do not disclose how many
 * schools exist or in what order they joined.
 */
export function generateSchoolCode(): string {
  let code = '';
  for (let i = 0; i < SCHOOL_CODE_LENGTH; i += 1) {
    code += SCHOOL_CODE_ALPHABET[randomInt(SCHOOL_CODE_ALPHABET.length)];
  }
  return code;
}
