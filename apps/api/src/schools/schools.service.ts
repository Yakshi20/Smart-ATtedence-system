import { Inject, Injectable, Logger } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { isUniqueViolation, schema, type Database } from '@smart-school/database';
import { DomainError, ErrorCode, type InviteStaffInput } from '@smart-school/shared';
import type { SchoolScope } from '../access/access.service';
import { writeAudit } from '../audit/audit';
import { ACCOUNT_NOTIFIER, type AccountNotifier, type ActivationMessage } from '../auth/account-notifier';
import type { RequestMeta } from '../common/request-meta';
import { CONFIG, type AppConfig } from '../config/env';
import { DATABASE } from '../database/database.module';
import { findOrCreateStaffUser, issueActivationToken } from '../identity/provisioning';

export interface SchoolView {
  id: string;
  schoolCode: string;
  name: string;
  sector: string;
  udiseCode: string | null;
  districtName: string;
  status: string;
}

export interface StaffMemberView {
  membershipId: string;
  userId: string;
  displayName: string;
  email: string | null;
  role: string;
  status: string;
  joinedAt: string;
}

/**
 * Every method takes a SchoolScope, not a school id, and filters on `scope.schoolId` — the
 * value read from the caller's own membership row. There is no code path from a URL
 * parameter to a query predicate that bypasses AccessService.
 */
@Injectable()
export class SchoolsService {
  private readonly logger = new Logger(SchoolsService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(ACCOUNT_NOTIFIER) private readonly notifier: AccountNotifier,
  ) {}

  async profile(scope: SchoolScope): Promise<SchoolView> {
    const [school] = await this.db
      .select({
        id: schema.schools.id,
        schoolCode: schema.schools.schoolCode,
        name: schema.schools.name,
        sector: schema.schools.sector,
        udiseCode: schema.schools.udiseCode,
        districtName: schema.schools.districtName,
        status: schema.schools.status,
      })
      .from(schema.schools)
      .where(eq(schema.schools.id, scope.schoolId));
    if (!school) throw new Error('school vanished after access was resolved');
    return school;
  }

  async listStaff(scope: SchoolScope): Promise<StaffMemberView[]> {
    const rows = await this.db
      .select({
        membershipId: schema.schoolMemberships.id,
        userId: schema.users.id,
        displayName: schema.users.displayName,
        email: schema.users.email,
        role: schema.schoolMemberships.role,
        status: schema.schoolMemberships.status,
        joinedAt: schema.schoolMemberships.createdAt,
      })
      .from(schema.schoolMemberships)
      .innerJoin(schema.users, eq(schema.users.id, schema.schoolMemberships.userId))
      .where(eq(schema.schoolMemberships.schoolId, scope.schoolId))
      .orderBy(asc(schema.users.displayName), asc(schema.schoolMemberships.id));

    return rows.map((r) => ({ ...r, joinedAt: r.joinedAt.toISOString() }));
  }

  /**
   * Adds a staff member to the caller's school, creating their account if needed.
   *
   * The response has the same shape whether or not the person already had an account, so a
   * school admin cannot use invitations to discover who is registered elsewhere on the
   * platform.
   */
  async inviteStaff(
    scope: SchoolScope,
    input: InviteStaffInput,
    meta: RequestMeta,
  ): Promise<{ membershipId: string; userId: string; role: string }> {
    let activation: ActivationMessage | null = null;

    const created = await this.db
      .transaction(async (tx) => {
        const [school] = await tx
          .select({ name: schema.schools.name })
          .from(schema.schools)
          .where(eq(schema.schools.id, scope.schoolId));

        const user = await findOrCreateStaffUser(tx, {
          email: input.email,
          displayName: input.displayName,
        });

        const [membership] = await tx
          .insert(schema.schoolMemberships)
          .values({
            schoolId: scope.schoolId,
            userId: user.userId,
            role: input.role,
            createdBy: scope.userId,
          })
          .returning({ id: schema.schoolMemberships.id });
        if (!membership) throw new Error('membership insert returned no row');

        if (user.needsActivation) {
          const issued = await issueActivationToken(tx, {
            userId: user.userId,
            createdBy: scope.userId,
            ttlSeconds: this.config.ACTIVATION_TOKEN_TTL_SECONDS,
          });
          activation = {
            userId: user.userId,
            email: user.email,
            displayName: user.displayName,
            token: issued.token,
            expiresAt: issued.expiresAt,
            schoolName: school?.name ?? '',
          };
        }

        await writeAudit(tx, {
          action: 'school_membership.created',
          entityType: 'school_membership',
          entityId: membership.id,
          actorUserId: scope.userId,
          schoolId: scope.schoolId,
          requestId: meta.requestId,
          metadata: { role: input.role, userId: user.userId, activationIssued: user.needsActivation },
        });

        return { membershipId: membership.id, userId: user.userId, role: input.role };
      })
      .catch((err: unknown) => {
        if (isUniqueViolation(err, 'school_memberships_school_user_key')) {
          throw new DomainError(
            ErrorCode.DUPLICATE_RESOURCE,
            'This person already has a membership in this school',
          );
        }
        throw err;
      });

    if (activation) {
      try {
        await this.notifier.sendActivation(activation);
      } catch (err) {
        this.logger.error(
          { requestId: meta.requestId, event: 'activation_delivery_failed' },
          err instanceof Error ? err.stack : String(err),
        );
      }
    }

    return created;
  }
}
