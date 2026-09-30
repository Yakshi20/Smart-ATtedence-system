/**
 * Permission registry and role defaults.
 *
 * Pure and dependency-free on purpose: every decision here is unit-testable without a
 * database, and the web portal can import the same definitions to hide controls a caller
 * cannot use. Hiding a control is cosmetic — the API re-checks every request.
 *
 * A permission answers "may this role perform this action?". It never answers "on which
 * object?" — that is the relationship check (school membership, teacher assignment,
 * guardian link) the API performs separately. Holding a permission without the matching
 * relationship grants nothing.
 */

export const Permission = {
  /** Review (approve / reject) public school registration requests. Platform scope. */
  SCHOOL_REGISTRATIONS_REVIEW: 'platform.school_registrations.review',

  /** Read the school's own profile. */
  SCHOOL_PROFILE_READ: 'school.profile.read',
  /** List the school's staff memberships. */
  SCHOOL_STAFF_READ: 'school.staff.read',
  /** Provision staff accounts and memberships in the school. */
  SCHOOL_STAFF_MANAGE: 'school.staff.manage',

  /** Read academic structure: years, grades, sections, subjects, class-subjects. No personal data. */
  SCHOOL_ACADEMIC_READ: 'school.academic.read',
  /** Create and change academic structure and year lifecycle. */
  SCHOOL_ACADEMIC_MANAGE: 'school.academic.manage',

  /** Read every student record and roster in the school. */
  SCHOOL_STUDENTS_READ: 'school.students.read',
  /**
   * Read students and rosters only of sections the caller is actively assigned to teach.
   * Holding this permission grants nothing on its own: each request also checks the
   * teacher-assignment relationship (02 §2, never by role alone).
   */
  SCHOOL_STUDENTS_READ_ASSIGNED: 'school.students.read_assigned',
  /** Create and update students; enrol, transfer, promote, withdraw; void enrolments. */
  SCHOOL_STUDENTS_MANAGE: 'school.students.manage',

  /** Assign and end teacher assignments; read all of them. */
  SCHOOL_TEACHER_ASSIGNMENTS_MANAGE: 'school.teacher_assignments.manage',
  /** Read one's own teacher assignments. */
  SCHOOL_TEACHER_ASSIGNMENTS_READ_OWN: 'school.teacher_assignments.read_own',

  /** Read guardian records and guardian–student links of the school. */
  SCHOOL_GUARDIANS_READ: 'school.guardians.read',
  /**
   * Create guardian records; initiate, verify, reject and revoke guardian links. Parents never
   * hold this: a guardian can request a link but never approve one.
   */
  SCHOOL_GUARDIANS_MANAGE: 'school.guardians.manage',

  /**
   * Open attendance sessions and submit registers. For a teacher it also requires an **active
   * assignment** to the session's class-subject, checked per request (relationship, not role).
   */
  SCHOOL_ATTENDANCE_MARK: 'school.attendance.mark',
  /** Read every attendance session and record in the school. Teachers instead read only their assigned class-subjects. */
  SCHOOL_ATTENDANCE_READ_ALL: 'school.attendance.read_all',
  /** Correct submitted attendance, with a reason (Q1: the principal approves corrections). */
  SCHOOL_ATTENDANCE_CORRECT: 'school.attendance.correct',
} as const;

export type Permission = (typeof Permission)[keyof typeof Permission];

export const ScopeType = {
  PLATFORM: 'platform',
  SCHOOL: 'school',
} as const;

export type ScopeType = (typeof ScopeType)[keyof typeof ScopeType];

export const PLATFORM_ROLES = ['platform_admin'] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

export const SCHOOL_ROLES = ['school_admin', 'teacher'] as const;
export type SchoolRole = (typeof SCHOOL_ROLES)[number];

/**
 * School roles that may hold a teacher assignment. Includes `school_admin` because in small
 * government schools the head teacher also teaches.
 */
export const TEACHING_ROLES: readonly SchoolRole[] = ['teacher', 'school_admin'];

type RoleOf<S extends ScopeType> = S extends 'platform' ? PlatformRole : SchoolRole;

/**
 * Default permissions per (scope type, role). Roles in different scopes live in separate
 * namespaces (D-02), so a platform role can never be confused with a school role even if
 * the two ever share a name.
 *
 * Deliberately, `platform_admin` holds no school-scoped permission at all: approving a
 * school's registration grants no access to that school's data (Q2, D-04). Support access
 * to school data will be a separate, time-bound, audited grant.
 */
const ROLE_DEFAULTS: { readonly [S in ScopeType]: Readonly<Record<RoleOf<S>, readonly Permission[]>> } = {
  platform: {
    platform_admin: [Permission.SCHOOL_REGISTRATIONS_REVIEW],
  },
  school: {
    school_admin: [
      Permission.SCHOOL_PROFILE_READ,
      Permission.SCHOOL_STAFF_READ,
      Permission.SCHOOL_STAFF_MANAGE,
      Permission.SCHOOL_ACADEMIC_READ,
      Permission.SCHOOL_ACADEMIC_MANAGE,
      Permission.SCHOOL_STUDENTS_READ,
      Permission.SCHOOL_STUDENTS_READ_ASSIGNED,
      Permission.SCHOOL_STUDENTS_MANAGE,
      Permission.SCHOOL_TEACHER_ASSIGNMENTS_MANAGE,
      Permission.SCHOOL_TEACHER_ASSIGNMENTS_READ_OWN,
      Permission.SCHOOL_GUARDIANS_READ,
      Permission.SCHOOL_GUARDIANS_MANAGE,
      Permission.SCHOOL_ATTENDANCE_MARK,
      Permission.SCHOOL_ATTENDANCE_READ_ALL,
      Permission.SCHOOL_ATTENDANCE_CORRECT,
    ],
    teacher: [
      Permission.SCHOOL_PROFILE_READ,
      Permission.SCHOOL_ACADEMIC_READ,
      Permission.SCHOOL_STUDENTS_READ_ASSIGNED,
      Permission.SCHOOL_TEACHER_ASSIGNMENTS_READ_OWN,
      Permission.SCHOOL_ATTENDANCE_MARK,
    ],
  },
};

/** Which scope each permission belongs to. A permission is only ever checked in its own scope. */
export function scopeOfPermission(permission: Permission): ScopeType {
  return permission.startsWith('platform.') ? ScopeType.PLATFORM : ScopeType.SCHOOL;
}

/**
 * Whether a role holds a permission by default.
 *
 * Fails closed: an unknown role, or a permission from another scope, is `false` rather than
 * an exception, so a malformed row read from the database can never widen access.
 */
export function roleHasPermission<S extends ScopeType>(
  scope: S,
  role: string,
  permission: Permission,
): boolean {
  if (scopeOfPermission(permission) !== scope) return false;
  const table = ROLE_DEFAULTS[scope] as Readonly<Record<string, readonly Permission[]>>;
  if (!Object.prototype.hasOwnProperty.call(table, role)) return false;
  return table[role]?.includes(permission) ?? false;
}

/** All permissions a role holds by default, for `/me` responses and UI hints. */
export function permissionsForRole<S extends ScopeType>(scope: S, role: string): Permission[] {
  const table = ROLE_DEFAULTS[scope] as Readonly<Record<string, readonly Permission[]>>;
  if (!Object.prototype.hasOwnProperty.call(table, role)) return [];
  return [...(table[role] ?? [])];
}
