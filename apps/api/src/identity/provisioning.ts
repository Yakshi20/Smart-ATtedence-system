import { and, eq, isNull, sql } from 'drizzle-orm';
import { schema, type Executor } from '@smart-school/database';
import { generateOpaqueToken, hashOpaqueToken } from '../auth/secrets';

export interface StaffUser {
  userId: string;
  email: string;
  displayName: string;
  /** True when the user has no password credential yet and must activate. */
  needsActivation: boolean;
}

/**
 * Returns the user for `email`, creating one if none exists.
 *
 * One `users` row per human (D-06): a teacher at two schools is one user with two
 * memberships. An existing user's display name is never overwritten by whoever provisions
 * them, so one school cannot rename a person known to another. Must run in the caller's
 * transaction.
 */
export async function findOrCreateStaffUser(
  tx: Executor,
  input: { email: string; displayName: string; phone?: string | null },
): Promise<StaffUser> {
  // ON CONFLICT DO NOTHING + re-select is race-safe against a concurrent provisioning of
  // the same email, where a plain select-then-insert would fail on the unique index.
  await tx
    .insert(schema.users)
    .values({ email: input.email, displayName: input.displayName, phone: input.phone ?? null })
    .onConflictDoNothing({ target: schema.users.email, where: sql`${schema.users.email} IS NOT NULL` });

  const [row] = await tx
    .select({
      userId: schema.users.id,
      email: schema.users.email,
      displayName: schema.users.displayName,
      identityId: schema.authIdentities.id,
    })
    .from(schema.users)
    .leftJoin(
      schema.authIdentities,
      and(
        eq(schema.authIdentities.userId, schema.users.id),
        eq(schema.authIdentities.provider, 'staff_password'),
      ),
    )
    .where(eq(schema.users.email, input.email));
  if (!row?.email) throw new Error('provisioned user could not be read back');

  return {
    userId: row.userId,
    email: row.email,
    displayName: row.displayName,
    needsActivation: row.identityId === null,
  };
}

/**
 * Issues a single-use activation token, superseding any the user still holds so only the
 * newest delivered token works. Only the SHA-256 is stored; the plaintext is returned for
 * out-of-band delivery and never persisted.
 */
export async function issueActivationToken(
  tx: Executor,
  input: { userId: string; createdBy: string | null; ttlSeconds: number },
): Promise<{ token: string; expiresAt: Date }> {
  await tx
    .update(schema.accountActivationTokens)
    .set({ usedAt: sql`now()` })
    .where(
      and(
        eq(schema.accountActivationTokens.userId, input.userId),
        isNull(schema.accountActivationTokens.usedAt),
      ),
    );

  const token = generateOpaqueToken();
  const [row] = await tx
    .insert(schema.accountActivationTokens)
    .values({
      userId: input.userId,
      tokenHash: hashOpaqueToken(token),
      createdBy: input.createdBy,
      expiresAt: sql`now() + make_interval(secs => ${input.ttlSeconds})`,
    })
    .returning({ expiresAt: schema.accountActivationTokens.expiresAt });
  if (!row) throw new Error('activation token insert returned no row');

  return { token, expiresAt: row.expiresAt };
}
