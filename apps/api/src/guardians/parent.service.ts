import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { schema, type Database, type Transaction } from '@smart-school/database';
import { notVisible, permissionDenied, type RelationshipType } from '@smart-school/shared';
import { studentAttendance } from '../attendance/student-attendance';
import { writeAudit } from '../audit/audit';
import type { Principal } from '../auth/principal';
import { RateLimiter } from '../common/rate-limiter';
import type { RequestMeta } from '../common/request-meta';
import { DATABASE } from '../database/database.module';

export interface ChildView {
  studentId: string;
  fullName: string;
  studentNumber: string;
  /** `withdrawn` / `transferred` children stay listed until the school revokes the link. */
  studentStatus: string;
  schoolId: string;
  schoolName: string;
  relationshipType: RelationshipType;
  currentPlacement: { academicYearName: string; gradeNumber: number; sectionName: string } | null;
}

export interface ClaimView {
  id: string;
  submittedAt: string;
  schoolCode: string;
  studentNumber: string;
  relationshipType: RelationshipType;
  /**
   * `pending` covers both "awaiting review" and "matched nothing", deliberately
   * indistinguishable. `declined` appears only after a school reviewer acted.
   */
  status: 'pending' | 'approved' | 'declined';
}

/**
 * The parent's view (06 §3 `/parents/me/*`).
 *
 * A child is visible only through this chain, re-evaluated on every request:
 *
 *   session user ─▶ phone_otp identity (phone proven by OTP)
 *                ─▶ guardians.phone = that phone (a record some school created or accepted)
 *                ─▶ student_guardians.status = 'verified' (a school reviewer approved it)
 *                ─▶ student, in a school whose status is 'active'
 *
 * Revoking the link, suspending the school, or disabling the account breaks the chain for the
 * next request. Knowing a student's id, number or date of birth adds nothing to it.
 */
@Injectable()
export class ParentService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly limiter: RateLimiter,
  ) {}

  async children(principal: Principal): Promise<{ items: ChildView[] }> {
    const phone = await this.phoneOf(principal);
    if (!phone) return { items: [] };
    return { items: await this.verifiedChildren(phone) };
  }

  /**
   * A verified-linked child's attendance, from the school where the link is verified. The link,
   * the school's status and the account are re-checked by `child()` on every call, so a revoked
   * link stops this on the next request. Correction reasons are staff notes and are not shown.
   */
  async childAttendance(principal: Principal, studentId: string, range: { from: string; to: string }) {
    const linked = await this.child(principal, studentId);
    return studentAttendance(this.db, { schoolId: linked.schoolId, studentId: linked.studentId, ...range });
  }

  /** 404 unless linked and verified — identical for another family's child and a random id. */
  async child(principal: Principal, studentId: string): Promise<ChildView> {
    const phone = await this.phoneOf(principal);
    const [child] = phone ? await this.verifiedChildren(phone, studentId) : [];
    if (!child) throw notVisible('child');
    return child;
  }

  /**
   * Stores the claim, then — only if the school code and student number identify an active
   * student in an active school — creates a pending link for that school to review, using a
   * guardian record keyed by the claimant's **verified** phone. The response does not depend on
   * whether anything matched.
   */
  async submitClaim(
    principal: Principal,
    input: { schoolCode: string; studentNumber: string; relationshipType: RelationshipType; guardianName: string },
    meta: RequestMeta,
  ): Promise<{ status: 'submitted' }> {
    const phone = await this.phoneOf(principal);
    if (!phone) throw permissionDenied('request a guardian link without a verified phone login');
    this.limiter.hit('linkClaimPerUser', principal.userId);

    await this.db.transaction(async (tx) => {
      const [claim] = await tx
        .insert(schema.guardianLinkClaims)
        .values({
          claimantUserId: principal.userId,
          claimantPhone: phone,
          schoolCode: input.schoolCode,
          studentNumber: input.studentNumber,
          relationshipType: input.relationshipType,
          claimantName: input.guardianName,
        })
        .returning({ id: schema.guardianLinkClaims.id });

      const match = await this.matchStudent(tx, input.schoolCode, input.studentNumber);
      if (!match) {
        await writeAudit(tx, {
          action: 'guardian_link_claim.submitted',
          entityType: 'guardian_link_claim',
          entityId: claim!.id,
          actorUserId: principal.userId,
          requestId: meta.requestId,
          metadata: { matched: false },
        });
        return;
      }

      const linkId = await this.pendingLinkFor(tx, match, phone, input, principal.userId);
      await tx
        .update(schema.guardianLinkClaims)
        .set({ schoolId: match.schoolId, linkId })
        .where(eq(schema.guardianLinkClaims.id, claim!.id));
      await writeAudit(tx, {
        action: 'guardian_link_claim.submitted',
        entityType: 'guardian_link_claim',
        entityId: claim!.id,
        actorUserId: principal.userId,
        schoolId: match.schoolId,
        requestId: meta.requestId,
        metadata: { matched: true, linkId, studentId: match.studentId },
      });
    });

    return { status: 'submitted' };
  }

  async claims(principal: Principal): Promise<{ items: ClaimView[] }> {
    const rows = await this.db
      .select({
        id: schema.guardianLinkClaims.id,
        createdAt: schema.guardianLinkClaims.createdAt,
        schoolCode: schema.guardianLinkClaims.schoolCode,
        studentNumber: schema.guardianLinkClaims.studentNumber,
        relationshipType: schema.guardianLinkClaims.relationshipType,
        linkStatus: schema.studentGuardians.status,
      })
      .from(schema.guardianLinkClaims)
      .leftJoin(schema.studentGuardians, eq(schema.studentGuardians.id, schema.guardianLinkClaims.linkId))
      .where(eq(schema.guardianLinkClaims.claimantUserId, principal.userId))
      .orderBy(desc(schema.guardianLinkClaims.createdAt), asc(schema.guardianLinkClaims.id))
      .limit(100);

    return {
      items: rows.map((r) => ({
        id: r.id,
        submittedAt: r.createdAt.toISOString(),
        schoolCode: r.schoolCode,
        studentNumber: r.studentNumber,
        relationshipType: r.relationshipType,
        status:
          r.linkStatus === 'verified'
            ? 'approved'
            : r.linkStatus === 'rejected' || r.linkStatus === 'revoked'
              ? 'declined'
              : 'pending',
      })),
    };
  }

  // ------------------------------------------------------------------ helpers

  /** The phone this user proved by OTP. Staff accounts (email + password) have none. */
  private async phoneOf(principal: Principal): Promise<string | null> {
    const [row] = await this.db
      .select({ phone: schema.authIdentities.providerSubject })
      .from(schema.authIdentities)
      .where(and(eq(schema.authIdentities.userId, principal.userId), eq(schema.authIdentities.provider, 'phone_otp')));
    return row?.phone ?? null;
  }

  private async verifiedChildren(phone: string, studentId?: string): Promise<ChildView[]> {
    const rows = await this.db
      .select({
        studentId: schema.students.id,
        fullName: schema.students.fullName,
        studentNumber: schema.students.studentNumber,
        studentStatus: schema.students.status,
        schoolId: schema.schools.id,
        schoolName: schema.schools.name,
        relationshipType: schema.studentGuardians.relationshipType,
        academicYearName: schema.academicYears.name,
        gradeNumber: schema.grades.gradeNumber,
        sectionName: schema.sections.name,
      })
      .from(schema.studentGuardians)
      .innerJoin(schema.guardians, eq(schema.guardians.id, schema.studentGuardians.guardianId))
      .innerJoin(schema.students, eq(schema.students.id, schema.studentGuardians.studentId))
      .innerJoin(schema.schools, eq(schema.schools.id, schema.studentGuardians.schoolId))
      // Current placement: the open enrolment in the school's active year, if any.
      .leftJoin(
        schema.enrollments,
        and(
          eq(schema.enrollments.studentId, schema.students.id),
          isNull(schema.enrollments.effectiveTo),
          isNull(schema.enrollments.voidedAt),
          sql`EXISTS (SELECT 1 FROM ${schema.academicYears} ay
                      WHERE ay.id = ${schema.enrollments.academicYearId} AND ay.status = 'active')`,
        ),
      )
      .leftJoin(schema.academicYears, eq(schema.academicYears.id, schema.enrollments.academicYearId))
      .leftJoin(schema.sections, eq(schema.sections.id, schema.enrollments.sectionId))
      .leftJoin(schema.grades, eq(schema.grades.id, schema.sections.gradeId))
      .where(
        and(
          eq(schema.guardians.phone, phone),
          eq(schema.studentGuardians.status, 'verified'),
          eq(schema.schools.status, 'active'),
          studentId ? eq(schema.students.id, studentId) : undefined,
        ),
      )
      .orderBy(asc(schema.students.fullName), asc(schema.students.id));

    return rows.map((r) => ({
      studentId: r.studentId,
      fullName: r.fullName,
      studentNumber: r.studentNumber,
      studentStatus: r.studentStatus,
      schoolId: r.schoolId,
      schoolName: r.schoolName,
      relationshipType: r.relationshipType,
      currentPlacement:
        r.academicYearName && r.gradeNumber !== null && r.sectionName
          ? { academicYearName: r.academicYearName, gradeNumber: r.gradeNumber, sectionName: r.sectionName }
          : null,
    }));
  }

  private async matchStudent(
    tx: Transaction,
    schoolCode: string,
    studentNumber: string,
  ): Promise<{ schoolId: string; studentId: string } | null> {
    const [row] = await tx
      .select({ schoolId: schema.schools.id, studentId: schema.students.id })
      .from(schema.students)
      .innerJoin(schema.schools, eq(schema.schools.id, schema.students.schoolId))
      .where(
        and(
          eq(schema.schools.schoolCode, schoolCode),
          eq(schema.schools.status, 'active'),
          eq(schema.students.studentNumber, studentNumber),
          eq(schema.students.status, 'active'),
        ),
      );
    return row ?? null;
  }

  /**
   * Finds or creates the school's guardian record for this phone (an existing record's name is
   * never overwritten by a claimant), then reuses a live link or creates a pending one.
   */
  private async pendingLinkFor(
    tx: Transaction,
    match: { schoolId: string; studentId: string },
    phone: string,
    input: { relationshipType: RelationshipType; guardianName: string },
    claimantUserId: string,
  ): Promise<string> {
    await tx
      .insert(schema.guardians)
      .values({ schoolId: match.schoolId, fullName: input.guardianName, phone, createdBy: claimantUserId })
      .onConflictDoNothing({ target: [schema.guardians.schoolId, schema.guardians.phone] });
    const [guardian] = await tx
      .select({ id: schema.guardians.id })
      .from(schema.guardians)
      .where(and(eq(schema.guardians.schoolId, match.schoolId), eq(schema.guardians.phone, phone)));

    const [live] = await tx
      .select({ id: schema.studentGuardians.id })
      .from(schema.studentGuardians)
      .where(
        and(
          eq(schema.studentGuardians.studentId, match.studentId),
          eq(schema.studentGuardians.guardianId, guardian!.id),
          sql`${schema.studentGuardians.status} IN ('pending', 'verified')`,
        ),
      )
      .for('update');
    if (live) return live.id;

    const [link] = await tx
      .insert(schema.studentGuardians)
      .values({
        schoolId: match.schoolId,
        studentId: match.studentId,
        guardianId: guardian!.id,
        relationshipType: input.relationshipType,
        initiatedVia: 'guardian_claim',
        createdBy: claimantUserId,
      })
      .returning({ id: schema.studentGuardians.id });
    return link!.id;
  }
}
