import { sql } from 'drizzle-orm';
import { schema, type Database } from '@smart-school/database';
import { EmailSchema, NewPasswordSchema, singleLineText } from '@smart-school/shared';
import { z } from 'zod';
import { writeAudit } from '../audit/audit';
import { hashPassword } from '../auth/secrets';
import { findOrCreateStaffUser } from './provisioning';

const InputSchema = z.object({
  email: EmailSchema,
  displayName: singleLineText(120),
  password: NewPasswordSchema,
});

export interface PlatformAdminResult {
  userId: string;
  /** False when the user already had a password: an existing credential is never replaced. */
  passwordSet: boolean;
}

/**
 * Grants the platform_admin role. Reachable only from an operator's shell via the CLI —
 * there is deliberately no HTTP route that can create or grant a platform role, so no
 * public or school-level request can escalate to one.
 */
export async function bootstrapPlatformAdmin(
  db: Database,
  raw: { email: string; displayName: string; password: string },
): Promise<PlatformAdminResult> {
  const input = InputSchema.parse(raw);
  const secretHash = await hashPassword(input.password);

  return db.transaction(async (tx) => {
    const user = await findOrCreateStaffUser(tx, { email: input.email, displayName: input.displayName });

    if (user.needsActivation) {
      await tx.insert(schema.authIdentities).values({
        userId: user.userId,
        provider: 'staff_password',
        providerSubject: user.email,
        secretHash,
      });
    }

    await tx
      .insert(schema.platformMemberships)
      .values({ userId: user.userId, role: 'platform_admin' })
      .onConflictDoUpdate({
        target: [schema.platformMemberships.userId, schema.platformMemberships.role],
        set: { status: 'active', updatedAt: sql`now()` },
      });

    await writeAudit(tx, {
      action: 'platform_membership.granted',
      entityType: 'user',
      entityId: user.userId,
      metadata: { role: 'platform_admin', via: 'cli', passwordSet: user.needsActivation },
    });

    return { userId: user.userId, passwordSet: user.needsActivation };
  });
}
