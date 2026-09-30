import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { schema, type Database } from '@smart-school/database';
import {
  Permission,
  roleHasPermission,
  ScopeType,
  scopeOfPermission,
  type SchoolRole,
} from '@smart-school/permissions';
import { notVisible, permissionDenied } from '@smart-school/shared';
import type { Principal } from '../auth/principal';
import { DATABASE } from '../database/database.module';

declare const schoolScopeBrand: unique symbol;

/**
 * Proof that the caller holds an active membership in an active school, with a role that
 * grants the requested permission.
 *
 * Branded so it can only be produced here. School-scoped services take a SchoolScope, never a
 * raw school id, so a query cannot be scoped by a value that came straight from the URL or
 * body (02 §4.3: a client-supplied school id is not proof of authorization). `schoolId` is
 * read back from the membership row, not echoed from the request.
 */
export type SchoolScope = {
  readonly schoolId: string;
  readonly membershipId: string;
  readonly role: SchoolRole;
  readonly userId: string;
} & { readonly [schoolScopeBrand]: true };

@Injectable()
export class AccessService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * Resolves the caller's scope in a school.
   *
   * - No active membership in an active school → 404. Identical whether the school exists
   *   or not, so ids cannot be probed across tenants (D-19).
   * - Member, but the role lacks the permission → 403. The caller already knows the school
   *   exists, so this reveals nothing.
   *
   * Platform roles are never consulted: a platform admin has no path into school data here.
   */
  async forSchool(principal: Principal, schoolId: string, permission: Permission): Promise<SchoolScope> {
    if (scopeOfPermission(permission) !== ScopeType.SCHOOL) {
      throw new Error(`${permission} is not a school-scoped permission`);
    }

    const [membership] = await this.db
      .select({
        schoolId: schema.schoolMemberships.schoolId,
        membershipId: schema.schoolMemberships.id,
        role: schema.schoolMemberships.role,
      })
      .from(schema.schoolMemberships)
      .innerJoin(schema.schools, eq(schema.schools.id, schema.schoolMemberships.schoolId))
      .where(
        and(
          eq(schema.schoolMemberships.userId, principal.userId),
          eq(schema.schoolMemberships.schoolId, schoolId),
          eq(schema.schoolMemberships.status, 'active'),
          eq(schema.schools.status, 'active'),
        ),
      );

    if (!membership) throw notVisible('school');
    if (!roleHasPermission(ScopeType.SCHOOL, membership.role, permission)) {
      throw permissionDenied(permission);
    }

    return { ...membership, userId: principal.userId } as SchoolScope;
  }

  /**
   * Requires a platform permission. Checked before the target resource is looked up, so a
   * non-platform caller receives the same 403 whether or not the resource exists.
   */
  async requirePlatform(principal: Principal, permission: Permission): Promise<void> {
    if (scopeOfPermission(permission) !== ScopeType.PLATFORM) {
      throw new Error(`${permission} is not a platform-scoped permission`);
    }

    const roles = await this.platformRolesOf(principal.userId);
    if (!roles.some((role) => roleHasPermission(ScopeType.PLATFORM, role, permission))) {
      throw permissionDenied(permission);
    }
  }

  async platformRolesOf(userId: string): Promise<string[]> {
    const rows = await this.db
      .select({ role: schema.platformMemberships.role })
      .from(schema.platformMemberships)
      .where(
        and(
          eq(schema.platformMemberships.userId, userId),
          eq(schema.platformMemberships.status, 'active'),
        ),
      );
    return rows.map((r) => r.role);
  }
}
