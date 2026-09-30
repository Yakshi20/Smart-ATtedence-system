import { Inject, Injectable, Logger } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { isUniqueViolation, schema, type Database, type Transaction } from '@smart-school/database';
import { Permission } from '@smart-school/permissions';
import {
  DomainError,
  ErrorCode,
  notVisible,
  type SchoolRegistrationRequestInput,
} from '@smart-school/shared';
import { AccessService } from '../access/access.service';
import { writeAudit } from '../audit/audit';
import { ACCOUNT_NOTIFIER, type AccountNotifier, type ActivationMessage } from '../auth/account-notifier';
import type { Principal } from '../auth/principal';
import { RateLimiter } from '../common/rate-limiter';
import type { RequestMeta } from '../common/request-meta';
import { CONFIG, type AppConfig } from '../config/env';
import { DATABASE } from '../database/database.module';
import { findOrCreateStaffUser, issueActivationToken } from '../identity/provisioning';
import { generateSchoolCode } from './school-code';

type RegistrationRow = typeof schema.schoolRegistrationRequests.$inferSelect;

export interface RegistrationRequestView {
  id: string;
  status: RegistrationRow['status'];
  schoolName: string;
  sector: RegistrationRow['sector'];
  udiseCode: string | null;
  districtName: string;
  addressLine: string;
  pincode: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  submittedAt: string;
  reviewedAt: string | null;
  reviewNote: string | null;
  schoolId: string | null;
}

export interface ApprovalResult {
  registrationRequestId: string;
  status: 'approved';
  school: { id: string; schoolCode: string; name: string; status: string };
}

const MAX_CODE_ATTEMPTS = 5;

@Injectable()
export class RegistrationService {
  private readonly logger = new Logger(RegistrationService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(ACCOUNT_NOTIFIER) private readonly notifier: AccountNotifier,
    private readonly access: AccessService,
    private readonly limiter: RateLimiter,
  ) {}

  /**
   * Public, unauthenticated. Writes only to the quarantined requests table (D-18): no school,
   * no user, no membership and no credential exists until a platform reviewer approves.
   *
   * The response is identical for every accepted submission — duplicates included — so
   * the endpoint cannot be used to learn whether a school or email is already known.
   */
  async submit(input: SchoolRegistrationRequestInput, meta: RequestMeta): Promise<void> {
    this.limiter.hit('registrationPerIp', meta.ip);
    this.limiter.hit('registrationPerEmail', input.contactEmail);

    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(schema.schoolRegistrationRequests)
        .values({
          schoolName: input.schoolName,
          sector: input.sector,
          udiseCode: input.udiseCode ?? null,
          districtName: input.districtName,
          addressLine: input.addressLine,
          pincode: input.pincode,
          contactName: input.contactName,
          contactEmail: input.contactEmail,
          contactPhone: input.contactPhone,
        })
        .returning({ id: schema.schoolRegistrationRequests.id });

      await writeAudit(tx, {
        action: 'school_registration.submitted',
        entityType: 'school_registration_request',
        entityId: row?.id ?? null,
        requestId: meta.requestId,
      });
    });
  }

  async list(
    principal: Principal,
    query: { status: RegistrationRow['status']; limit: number; offset: number },
  ): Promise<{ items: RegistrationRequestView[]; limit: number; offset: number }> {
    await this.access.requirePlatform(principal, Permission.SCHOOL_REGISTRATIONS_REVIEW);

    const rows = await this.db
      .select()
      .from(schema.schoolRegistrationRequests)
      .where(eq(schema.schoolRegistrationRequests.status, query.status))
      .orderBy(asc(schema.schoolRegistrationRequests.submittedAt), asc(schema.schoolRegistrationRequests.id))
      .limit(query.limit)
      .offset(query.offset);

    return { items: rows.map(toView), limit: query.limit, offset: query.offset };
  }

  async get(principal: Principal, id: string): Promise<RegistrationRequestView> {
    await this.access.requirePlatform(principal, Permission.SCHOOL_REGISTRATIONS_REVIEW);

    const [row] = await this.db
      .select()
      .from(schema.schoolRegistrationRequests)
      .where(eq(schema.schoolRegistrationRequests.id, id));
    if (!row) throw notVisible('school registration request');
    return toView(row);
  }

  /**
   * Approval, in one transaction: the school with a fresh unique code, the contact's user
   * account (or their existing one), a `school_admin` membership, an activation token if the
   * user has no password yet, the request's decision, and the audit trail. Either all of it
   * commits or none of it does.
   *
   * The reviewer receives the school but never the activation token, which goes only to the
   * contact through the notifier.
   */
  async approve(
    principal: Principal,
    id: string,
    input: { note?: string | undefined },
    meta: RequestMeta,
  ): Promise<ApprovalResult> {
    await this.access.requirePlatform(principal, Permission.SCHOOL_REGISTRATIONS_REVIEW);

    for (let attempt = 1; ; attempt += 1) {
      try {
        const { result, activation } = await this.db.transaction((tx) =>
          this.approveInTransaction(tx, principal, id, input, meta),
        );
        if (activation) await this.deliver(activation, meta);
        return result;
      } catch (err) {
        // A school-code collision aborts the transaction; retry with a new code.
        if (isUniqueViolation(err, 'schools_school_code_key') && attempt < MAX_CODE_ATTEMPTS) continue;
        if (isUniqueViolation(err, 'schools_udise_code_key')) {
          throw new DomainError(
            ErrorCode.DUPLICATE_RESOURCE,
            'A school with this UDISE code is already registered',
          );
        }
        throw err;
      }
    }
  }

  private async approveInTransaction(
    tx: Transaction,
    principal: Principal,
    id: string,
    input: { note?: string | undefined },
    meta: RequestMeta,
  ): Promise<{ result: ApprovalResult; activation: ActivationMessage | null }> {
    // Locks the request so two reviewers acting at once cannot both approve it.
    const [request] = await tx
      .select()
      .from(schema.schoolRegistrationRequests)
      .where(eq(schema.schoolRegistrationRequests.id, id))
      .for('update');
    if (!request) throw notVisible('school registration request');
    if (request.status !== 'pending') {
      throw new DomainError(ErrorCode.STATE_CONFLICT, 'Registration request has already been decided');
    }

    const [school] = await tx
      .insert(schema.schools)
      .values({
        schoolCode: generateSchoolCode(),
        name: request.schoolName,
        sector: request.sector,
        udiseCode: request.udiseCode,
        districtName: request.districtName,
        status: 'active',
      })
      .returning();
    if (!school) throw new Error('school insert returned no row');

    const admin = await findOrCreateStaffUser(tx, {
      email: request.contactEmail,
      displayName: request.contactName,
      phone: request.contactPhone,
    });

    const [membership] = await tx
      .insert(schema.schoolMemberships)
      .values({
        schoolId: school.id,
        userId: admin.userId,
        role: 'school_admin',
        createdBy: principal.userId,
      })
      .returning({ id: schema.schoolMemberships.id });

    const activation = admin.needsActivation
      ? await issueActivationToken(tx, {
          userId: admin.userId,
          createdBy: principal.userId,
          ttlSeconds: this.config.ACTIVATION_TOKEN_TTL_SECONDS,
        })
      : null;

    await tx
      .update(schema.schoolRegistrationRequests)
      .set({
        status: 'approved',
        reviewedBy: principal.userId,
        reviewedAt: new Date(),
        reviewNote: input.note ?? null,
        schoolId: school.id,
      })
      .where(eq(schema.schoolRegistrationRequests.id, id));

    await writeAudit(tx, {
      action: 'school_registration.approved',
      entityType: 'school_registration_request',
      entityId: id,
      actorUserId: principal.userId,
      schoolId: school.id,
      requestId: meta.requestId,
    });
    await writeAudit(tx, {
      action: 'school_membership.created',
      entityType: 'school_membership',
      entityId: membership?.id ?? null,
      actorUserId: principal.userId,
      schoolId: school.id,
      requestId: meta.requestId,
      metadata: { role: 'school_admin', userId: admin.userId, activationIssued: activation !== null },
    });

    return {
      result: {
        registrationRequestId: id,
        status: 'approved',
        school: { id: school.id, schoolCode: school.schoolCode, name: school.name, status: school.status },
      },
      activation: activation
        ? {
            userId: admin.userId,
            email: admin.email,
            displayName: admin.displayName,
            token: activation.token,
            expiresAt: activation.expiresAt,
            schoolName: school.name,
          }
        : null,
    };
  }

  async reject(
    principal: Principal,
    id: string,
    input: { reason: string },
    meta: RequestMeta,
  ): Promise<{ registrationRequestId: string; status: 'rejected' }> {
    await this.access.requirePlatform(principal, Permission.SCHOOL_REGISTRATIONS_REVIEW);

    await this.db.transaction(async (tx) => {
      const [request] = await tx
        .select({ status: schema.schoolRegistrationRequests.status })
        .from(schema.schoolRegistrationRequests)
        .where(eq(schema.schoolRegistrationRequests.id, id))
        .for('update');
      if (!request) throw notVisible('school registration request');
      if (request.status !== 'pending') {
        throw new DomainError(ErrorCode.STATE_CONFLICT, 'Registration request has already been decided');
      }

      await tx
        .update(schema.schoolRegistrationRequests)
        .set({
          status: 'rejected',
          reviewedBy: principal.userId,
          reviewedAt: new Date(),
          reviewNote: input.reason,
        })
        .where(eq(schema.schoolRegistrationRequests.id, id));

      await writeAudit(tx, {
        action: 'school_registration.rejected',
        entityType: 'school_registration_request',
        entityId: id,
        actorUserId: principal.userId,
        requestId: meta.requestId,
      });
    });

    return { registrationRequestId: id, status: 'rejected' };
  }

  /**
   * Delivery happens after commit, so a message is never sent for a rolled-back approval.
   * A delivery failure does not undo the approval; it is logged for follow-up (re-issuing
   * activation is a tracked backlog item).
   */
  private async deliver(message: ActivationMessage, meta: RequestMeta): Promise<void> {
    try {
      await this.notifier.sendActivation(message);
    } catch (err) {
      this.logger.error(
        { requestId: meta.requestId, userId: message.userId, event: 'activation_delivery_failed' },
        err instanceof Error ? err.stack : String(err),
      );
    }
  }
}

function toView(row: RegistrationRow): RegistrationRequestView {
  return {
    id: row.id,
    status: row.status,
    schoolName: row.schoolName,
    sector: row.sector,
    udiseCode: row.udiseCode,
    districtName: row.districtName,
    addressLine: row.addressLine,
    pincode: row.pincode,
    contactName: row.contactName,
    contactEmail: row.contactEmail,
    contactPhone: row.contactPhone,
    submittedAt: row.submittedAt.toISOString(),
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    reviewNote: row.reviewNote,
    schoolId: row.schoolId,
  };
}
