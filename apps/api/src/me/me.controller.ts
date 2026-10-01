import { Controller, Get, Inject } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { schema, type Database } from '@smart-school/database';
import { permissionsForRole, ScopeType, type Permission } from '@smart-school/permissions';
import { AccessService } from '../access/access.service';
import { CurrentPrincipal, type Principal } from '../auth/principal';
import { DATABASE } from '../database/database.module';

interface MeResponse {
  user: { id: string; displayName: string; email: string | null; preferredLanguage: string };
  platform: { roles: string[]; permissions: Permission[] };
}

interface MySchool {
  schoolId: string;
  schoolCode: string;
  name: string;
  schoolStatus: string;
  role: string;
  permissions: Permission[];
}

/**
 * The caller's own identity and memberships. Permissions are returned only as UI hints —
 * every endpoint re-checks them against the database.
 */
@Controller('me')
export class MeController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly access: AccessService,
  ) {}

  @Get()
  async me(@CurrentPrincipal() principal: Principal): Promise<MeResponse> {
    const [user] = await this.db
      .select({
        id: schema.users.id,
        displayName: schema.users.displayName,
        email: schema.users.email,
        preferredLanguage: schema.users.preferredLanguage,
      })
      .from(schema.users)
      .where(eq(schema.users.id, principal.userId));
    if (!user) throw new Error('authenticated user not found');

    const roles = await this.access.platformRolesOf(principal.userId);
    const permissions = [...new Set(roles.flatMap((r) => permissionsForRole(ScopeType.PLATFORM, r)))];
    return { user, platform: { roles, permissions } };
  }

  /** Active memberships only. A suspended school is listed so the client can explain why it is unusable. */
  @Get('schools')
  async schools(@CurrentPrincipal() principal: Principal): Promise<{ items: MySchool[] }> {
    const rows = await this.db
      .select({
        schoolId: schema.schools.id,
        schoolCode: schema.schools.schoolCode,
        name: schema.schools.name,
        schoolStatus: schema.schools.status,
        role: schema.schoolMemberships.role,
      })
      .from(schema.schoolMemberships)
      .innerJoin(schema.schools, eq(schema.schools.id, schema.schoolMemberships.schoolId))
      .where(
        and(
          eq(schema.schoolMemberships.userId, principal.userId),
          eq(schema.schoolMemberships.status, 'active'),
        ),
      )
      .orderBy(asc(schema.schools.name), asc(schema.schools.id));

    return {
      items: rows.map((r) => ({
        ...r,
        permissions: r.schoolStatus === 'active' ? permissionsForRole(ScopeType.SCHOOL, r.role) : [],
      })),
    };
  }
}
