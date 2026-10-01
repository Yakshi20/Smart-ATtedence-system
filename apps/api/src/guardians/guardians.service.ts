import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';
import { schema, type Database, type Transaction } from '@smart-school/database';
import { DomainError, ErrorCode, notVisible, permissionDenied, type RelationshipType } from '@smart-school/shared';
import type { SchoolScope } from '../access/access.service';
import { conflict, duplicate, now, translateConstraint } from '../academic/academic-common';
import { writeAudit } from '../audit/audit';
import type { RequestMeta } from '../common/request-meta';
import { DATABASE } from '../database/database.module';

type LinkRow = typeof schema.studentGuardians.$inferSelect;
type LinkStatus = LinkRow['status'];

export interface GuardianView {
  id: string;
  fullName: string;
  phone: string;
}

export interface GuardianLinkView {
  id: string;
  studentId: string;
  studentName: string;
  studentNumber: string;
  studentStatus: string;
  guardianId: string;
  guardianName: string;
  guardianPhone: string;
  relationshipType: RelationshipType;
  status: LinkStatus;
  initiatedVia: 'school' | 'guardian_claim';
  createdAt: string;
  verifiedAt: string | null;
  rejectedAt: string | null;
  revokedAt: string | null;
  statusReason: string | null;
  /** Other pending or verified links on the same student — surfaces conflicting claims to the reviewer. */
  otherLiveLinksForStudent: number;
}

const LINK_CONSTRAINTS = {
  student_guardians_one_live: conflict('This guardian already has a pending or verified link to this student'),
  guardians_school_phone_key: duplicate('A guardian with this phone number already exists in this school'),
};

/**
 * School-side guardian management (08 §4 steps 2–3, 6).
 *
 * Link workflow, enforced here and by the trigger in 0003:
 *
 *     pending ──verify──▶ verified ──revoke──▶ revoked
 *        └──────reject──▶ rejected
 *
 * Only staff with `school.guardians.manage` decide. Parents can only create `pending` links
 * (through a claim), never move one. A staff member cannot verify a link whose guardian phone is
 * their own. Each decision records who and when on the row and in audit_logs; reasons stay on
 * the access-controlled row.
 */
@Injectable()
export class GuardiansService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  // ------------------------------------------------------------------ guardian records

  async list(
    scope: SchoolScope,
    query: { phone?: string | undefined; limit: number; offset: number },
  ): Promise<{ items: GuardianView[]; limit: number; offset: number }> {
    const items = await this.db
      .select({ id: schema.guardians.id, fullName: schema.guardians.fullName, phone: schema.guardians.phone })
      .from(schema.guardians)
      .where(and(eq(schema.guardians.schoolId, scope.schoolId), query.phone ? eq(schema.guardians.phone, query.phone) : undefined))
      .orderBy(asc(schema.guardians.fullName), asc(schema.guardians.id))
      .limit(query.limit)
      .offset(query.offset);
    return { items, limit: query.limit, offset: query.offset };
  }

  async get(scope: SchoolScope, guardianId: string): Promise<GuardianView & { links: GuardianLinkView[] }> {
    const guardian = await this.findGuardian(this.db, scope, guardianId);
    const links = await this.linkViews(scope, eq(schema.studentGuardians.guardianId, guardian.id));
    return { id: guardian.id, fullName: guardian.fullName, phone: guardian.phone, links };
  }

  async create(scope: SchoolScope, input: { fullName: string; phone: string }, meta: RequestMeta): Promise<GuardianView> {
    try {
      return await this.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(schema.guardians)
          .values({ schoolId: scope.schoolId, fullName: input.fullName, phone: input.phone, createdBy: scope.userId })
          .returning();
        await this.audit(tx, scope, meta, 'guardian.created', 'guardian', row!.id, {});
        return { id: row!.id, fullName: row!.fullName, phone: row!.phone };
      });
    } catch (err) {
      translateConstraint(err, LINK_CONSTRAINTS);
    }
  }

  /**
   * The phone number is what connects a parent's login to this record, so changing it would
   * silently hand every link to whoever owns the new number. It may change only while the record
   * has no pending or verified link; otherwise revoke, correct, and link again.
   */
  async update(
    scope: SchoolScope,
    guardianId: string,
    input: { fullName?: string | undefined; phone?: string | undefined },
    meta: RequestMeta,
  ): Promise<GuardianView> {
    try {
      return await this.db.transaction(async (tx) => {
        const guardian = await this.findGuardian(tx, scope, guardianId, true);
        const phoneChanges = input.phone !== undefined && input.phone !== guardian.phone;
        if (phoneChanges) {
          const [live] = await tx
            .select({ id: schema.studentGuardians.id })
            .from(schema.studentGuardians)
            .where(
              and(
                eq(schema.studentGuardians.guardianId, guardian.id),
                inArray(schema.studentGuardians.status, ['pending', 'verified']),
              ),
            )
            .limit(1);
          if (live) {
            throw new DomainError(
              ErrorCode.STATE_CONFLICT,
              'The phone number cannot change while the guardian has pending or verified links; revoke them first',
            );
          }
        }
        const [row] = await tx
          .update(schema.guardians)
          .set({
            ...(input.fullName !== undefined ? { fullName: input.fullName } : {}),
            ...(input.phone !== undefined ? { phone: input.phone } : {}),
            updatedAt: now,
          })
          .where(eq(schema.guardians.id, guardian.id))
          .returning();
        await this.audit(tx, scope, meta, 'guardian.updated', 'guardian', guardian.id, {
          nameChanged: input.fullName !== undefined,
          phoneChanged: phoneChanges,
        });
        return { id: row!.id, fullName: row!.fullName, phone: row!.phone };
      });
    } catch (err) {
      translateConstraint(err, LINK_CONSTRAINTS);
    }
  }

  // ------------------------------------------------------------------ links

  /** Staff-initiated link. Always starts `pending`; verification is a separate, recorded step. */
  async createLink(
    scope: SchoolScope,
    studentId: string,
    input: { guardianId: string; relationshipType: RelationshipType },
    meta: RequestMeta,
  ): Promise<GuardianLinkView> {
    try {
      const id = await this.db.transaction(async (tx) => {
        const [student] = await tx
          .select({ id: schema.students.id, status: schema.students.status })
          .from(schema.students)
          .where(and(eq(schema.students.id, studentId), eq(schema.students.schoolId, scope.schoolId)));
        if (!student) throw notVisible('student');
        if (student.status !== 'active') {
          throw new DomainError(ErrorCode.BUSINESS_RULE_VIOLATION, `A ${student.status} student cannot be given a new guardian link`);
        }
        const guardian = await this.findGuardian(tx, scope, input.guardianId);

        const [row] = await tx
          .insert(schema.studentGuardians)
          .values({
            schoolId: scope.schoolId,
            studentId: student.id,
            guardianId: guardian.id,
            relationshipType: input.relationshipType,
            initiatedVia: 'school',
            createdBy: scope.userId,
          })
          .returning({ id: schema.studentGuardians.id });
        await this.audit(tx, scope, meta, 'guardian_link.created', 'student_guardian', row!.id, {
          studentId: student.id,
          guardianId: guardian.id,
          relationshipType: input.relationshipType,
          initiatedVia: 'school',
        });
        return row!.id;
      });
      return this.getLink(scope, id);
    } catch (err) {
      translateConstraint(err, LINK_CONSTRAINTS);
    }
  }

  async listLinks(
    scope: SchoolScope,
    query: { status: LinkStatus; limit: number; offset: number },
  ): Promise<{ items: GuardianLinkView[]; limit: number; offset: number }> {
    const items = await this.linkViews(scope, eq(schema.studentGuardians.status, query.status), query);
    return { items, limit: query.limit, offset: query.offset };
  }

  async studentLinks(scope: SchoolScope, studentId: string): Promise<{ items: GuardianLinkView[] }> {
    const [student] = await this.db
      .select({ id: schema.students.id })
      .from(schema.students)
      .where(and(eq(schema.students.id, studentId), eq(schema.students.schoolId, scope.schoolId)));
    if (!student) throw notVisible('student');
    return { items: await this.linkViews(scope, eq(schema.studentGuardians.studentId, studentId)) };
  }

  async verify(scope: SchoolScope, linkId: string, meta: RequestMeta): Promise<GuardianLinkView> {
    await this.db.transaction(async (tx) => {
      const { link, guardianPhone } = await this.lockLink(tx, scope, linkId);
      if (link.status !== 'pending') {
        throw new DomainError(ErrorCode.STATE_CONFLICT, `Only a pending link can be verified; this one is ${link.status}`);
      }
      await this.forbidSelfApproval(tx, scope, guardianPhone);

      const [student] = await tx
        .select({ status: schema.students.status })
        .from(schema.students)
        .where(eq(schema.students.id, link.studentId));
      if (student?.status !== 'active') {
        throw new DomainError(ErrorCode.BUSINESS_RULE_VIOLATION, 'Links can only be verified for an active student');
      }

      await tx
        .update(schema.studentGuardians)
        .set({ status: 'verified', verifiedBy: scope.userId, verifiedAt: now })
        .where(eq(schema.studentGuardians.id, link.id));
      await this.audit(tx, scope, meta, 'guardian_link.verified', 'student_guardian', link.id, {
        studentId: link.studentId,
        guardianId: link.guardianId,
        relationshipType: link.relationshipType,
      });
    });
    return this.getLink(scope, linkId);
  }

  async reject(scope: SchoolScope, linkId: string, reason: string, meta: RequestMeta): Promise<GuardianLinkView> {
    await this.db.transaction(async (tx) => {
      const { link } = await this.lockLink(tx, scope, linkId);
      if (link.status !== 'pending') {
        throw new DomainError(ErrorCode.STATE_CONFLICT, `Only a pending link can be rejected; this one is ${link.status}`);
      }
      await tx
        .update(schema.studentGuardians)
        .set({ status: 'rejected', rejectedBy: scope.userId, rejectedAt: now, statusReason: reason })
        .where(eq(schema.studentGuardians.id, link.id));
      await this.audit(tx, scope, meta, 'guardian_link.rejected', 'student_guardian', link.id, {
        studentId: link.studentId,
        guardianId: link.guardianId,
      });
    });
    return this.getLink(scope, linkId);
  }

  /** Takes effect on the parent's very next request: access is re-derived from this row each time. */
  async revoke(scope: SchoolScope, linkId: string, reason: string, meta: RequestMeta): Promise<GuardianLinkView> {
    await this.db.transaction(async (tx) => {
      const { link } = await this.lockLink(tx, scope, linkId);
      if (link.status !== 'verified') {
        throw new DomainError(ErrorCode.STATE_CONFLICT, `Only a verified link can be revoked; this one is ${link.status}`);
      }
      await tx
        .update(schema.studentGuardians)
        .set({ status: 'revoked', revokedBy: scope.userId, revokedAt: now, statusReason: reason })
        .where(eq(schema.studentGuardians.id, link.id));
      await this.audit(tx, scope, meta, 'guardian_link.revoked', 'student_guardian', link.id, {
        studentId: link.studentId,
        guardianId: link.guardianId,
      });
    });
    return this.getLink(scope, linkId);
  }

  // ------------------------------------------------------------------ helpers

  private async getLink(scope: SchoolScope, linkId: string): Promise<GuardianLinkView> {
    const [view] = await this.linkViews(scope, eq(schema.studentGuardians.id, linkId));
    if (!view) throw notVisible('guardian link');
    return view;
  }

  private async lockLink(tx: Transaction, scope: SchoolScope, linkId: string) {
    const [row] = await tx
      .select({ link: schema.studentGuardians, guardianPhone: schema.guardians.phone })
      .from(schema.studentGuardians)
      .innerJoin(schema.guardians, eq(schema.guardians.id, schema.studentGuardians.guardianId))
      .where(and(eq(schema.studentGuardians.id, linkId), eq(schema.studentGuardians.schoolId, scope.schoolId)))
      .for('update', { of: schema.studentGuardians });
    if (!row) throw notVisible('guardian link');
    return row;
  }

  /**
   * A reviewer may not verify a link to a guardian whose phone is their own — whether recorded on
   * their user or as their phone login. Two separate accounts held by one person cannot be
   * detected this way; that residual risk is documented (a maker–checker rule is a follow-up).
   */
  private async forbidSelfApproval(tx: Transaction, scope: SchoolScope, guardianPhone: string): Promise<void> {
    const [match] = await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .leftJoin(
        schema.authIdentities,
        and(eq(schema.authIdentities.userId, schema.users.id), eq(schema.authIdentities.provider, 'phone_otp')),
      )
      .where(
        and(
          eq(schema.users.id, scope.userId),
          or(eq(schema.users.phone, guardianPhone), eq(schema.authIdentities.providerSubject, guardianPhone)),
        ),
      )
      .limit(1);
    if (match) throw permissionDenied('verify a guardian link to yourself');
  }

  private async findGuardian(tx: Transaction | Database, scope: SchoolScope, guardianId: string, lock = false) {
    const query = tx
      .select()
      .from(schema.guardians)
      .where(and(eq(schema.guardians.id, guardianId), eq(schema.guardians.schoolId, scope.schoolId)));
    const [row] = lock ? await query.for('update') : await query;
    if (!row) throw notVisible('guardian');
    return row;
  }

  private async linkViews(
    scope: SchoolScope,
    filter: ReturnType<typeof eq>,
    page: { limit: number; offset: number } = { limit: 500, offset: 0 },
  ): Promise<GuardianLinkView[]> {
    const sg = schema.studentGuardians;
    const rows = await this.db
      .select({
        link: sg,
        studentName: schema.students.fullName,
        studentNumber: schema.students.studentNumber,
        studentStatus: schema.students.status,
        guardianName: schema.guardians.fullName,
        guardianPhone: schema.guardians.phone,
        otherLive: sql<number>`(
          SELECT count(*)::int FROM ${sg} other
          WHERE other.student_id = ${sg.studentId} AND other.id <> ${sg.id}
            AND other.status IN ('pending', 'verified'))`,
      })
      .from(sg)
      .innerJoin(schema.students, eq(schema.students.id, sg.studentId))
      .innerJoin(schema.guardians, eq(schema.guardians.id, sg.guardianId))
      .where(and(eq(sg.schoolId, scope.schoolId), filter))
      .orderBy(asc(sg.createdAt), asc(sg.id))
      .limit(page.limit)
      .offset(page.offset);

    return rows.map((r) => ({
      id: r.link.id,
      studentId: r.link.studentId,
      studentName: r.studentName,
      studentNumber: r.studentNumber,
      studentStatus: r.studentStatus,
      guardianId: r.link.guardianId,
      guardianName: r.guardianName,
      guardianPhone: r.guardianPhone,
      relationshipType: r.link.relationshipType,
      status: r.link.status,
      initiatedVia: r.link.initiatedVia,
      createdAt: r.link.createdAt.toISOString(),
      verifiedAt: r.link.verifiedAt?.toISOString() ?? null,
      rejectedAt: r.link.rejectedAt?.toISOString() ?? null,
      revokedAt: r.link.revokedAt?.toISOString() ?? null,
      statusReason: r.link.statusReason,
      otherLiveLinksForStudent: r.otherLive,
    }));
  }

  private audit(
    tx: Transaction,
    scope: SchoolScope,
    meta: RequestMeta,
    action: string,
    entityType: string,
    entityId: string,
    metadata: Record<string, string | number | boolean | null>,
  ): Promise<void> {
    return writeAudit(tx, {
      action,
      entityType,
      entityId,
      actorUserId: scope.userId,
      schoolId: scope.schoolId,
      requestId: meta.requestId,
      metadata,
    });
  }
}
