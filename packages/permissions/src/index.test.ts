import {
  Permission,
  PLATFORM_ROLES,
  SCHOOL_ROLES,
  ScopeType,
  TEACHING_ROLES,
  permissionsForRole,
  roleHasPermission,
  scopeOfPermission,
} from './index';

const schoolPermissions = Object.values(Permission).filter(
  (p) => scopeOfPermission(p) === ScopeType.SCHOOL,
);

test('platform_admin holds no school-scoped permission (Q2: approval is not data access)', () => {
  for (const permission of schoolPermissions) {
    expect(roleHasPermission(ScopeType.PLATFORM, 'platform_admin', permission)).toBe(false);
    expect(roleHasPermission(ScopeType.SCHOOL, 'platform_admin', permission)).toBe(false);
  }
});

test('only platform_admin may review school registrations', () => {
  expect(
    roleHasPermission(ScopeType.PLATFORM, 'platform_admin', Permission.SCHOOL_REGISTRATIONS_REVIEW),
  ).toBe(true);
  for (const role of SCHOOL_ROLES) {
    expect(roleHasPermission(ScopeType.SCHOOL, role, Permission.SCHOOL_REGISTRATIONS_REVIEW)).toBe(false);
    expect(roleHasPermission(ScopeType.PLATFORM, role, Permission.SCHOOL_REGISTRATIONS_REVIEW)).toBe(
      false,
    );
  }
});

test('a school role name cannot be used in the platform namespace', () => {
  expect(permissionsForRole(ScopeType.PLATFORM, 'school_admin')).toEqual([]);
});

test('teachers can read the school profile but not staff', () => {
  expect(roleHasPermission(ScopeType.SCHOOL, 'teacher', Permission.SCHOOL_PROFILE_READ)).toBe(true);
  expect(roleHasPermission(ScopeType.SCHOOL, 'teacher', Permission.SCHOOL_STAFF_READ)).toBe(false);
  expect(roleHasPermission(ScopeType.SCHOOL, 'teacher', Permission.SCHOOL_STAFF_MANAGE)).toBe(false);
});

test('school_admin manages its staff', () => {
  expect(roleHasPermission(ScopeType.SCHOOL, 'school_admin', Permission.SCHOOL_STAFF_MANAGE)).toBe(true);
});

test.each(['', 'admin', 'SCHOOL_ADMIN', 'toString', '__proto__', 'constructor'])(
  'unknown role %p fails closed',
  (role) => {
    expect(permissionsForRole(ScopeType.SCHOOL, role)).toEqual([]);
    for (const permission of Object.values(Permission)) {
      expect(roleHasPermission(ScopeType.SCHOOL, role, permission)).toBe(false);
      expect(roleHasPermission(ScopeType.PLATFORM, role, permission)).toBe(false);
    }
  },
);

test('every declared role is known to the registry', () => {
  for (const role of PLATFORM_ROLES) {
    expect(permissionsForRole(ScopeType.PLATFORM, role).length).toBeGreaterThan(0);
  }
  for (const role of SCHOOL_ROLES) {
    expect(permissionsForRole(ScopeType.SCHOOL, role).length).toBeGreaterThan(0);
  }
});

describe('Slice 2 permissions', () => {
  test('teachers read structure and assigned students only; they manage nothing', () => {
    const teacher = permissionsForRole(ScopeType.SCHOOL, 'teacher');
    expect(teacher).toEqual(
      expect.arrayContaining([
        Permission.SCHOOL_ACADEMIC_READ,
        Permission.SCHOOL_STUDENTS_READ_ASSIGNED,
        Permission.SCHOOL_TEACHER_ASSIGNMENTS_READ_OWN,
      ]),
    );
    for (const p of [
      Permission.SCHOOL_ACADEMIC_MANAGE,
      Permission.SCHOOL_STUDENTS_READ,
      Permission.SCHOOL_STUDENTS_MANAGE,
      Permission.SCHOOL_TEACHER_ASSIGNMENTS_MANAGE,
    ]) {
      expect(teacher).not.toContain(p);
    }
  });

  test('school_admin manages structure, students and assignments', () => {
    for (const p of [
      Permission.SCHOOL_ACADEMIC_MANAGE,
      Permission.SCHOOL_STUDENTS_MANAGE,
      Permission.SCHOOL_TEACHER_ASSIGNMENTS_MANAGE,
    ]) {
      expect(roleHasPermission(ScopeType.SCHOOL, 'school_admin', p)).toBe(true);
    }
  });

  test('teaching roles are school roles', () => {
    for (const role of TEACHING_ROLES) expect(SCHOOL_ROLES).toContain(role);
  });
});

test('guardian records and links are managed by school admins only (Slice 3)', () => {
  for (const p of [Permission.SCHOOL_GUARDIANS_READ, Permission.SCHOOL_GUARDIANS_MANAGE]) {
    expect(roleHasPermission(ScopeType.SCHOOL, 'school_admin', p)).toBe(true);
    expect(roleHasPermission(ScopeType.SCHOOL, 'teacher', p)).toBe(false);
    expect(roleHasPermission(ScopeType.PLATFORM, 'platform_admin', p)).toBe(false);
  }
});

test('attendance: teachers mark (relationship-gated); only admins read all and correct (Slice 4)', () => {
  expect(roleHasPermission(ScopeType.SCHOOL, 'teacher', Permission.SCHOOL_ATTENDANCE_MARK)).toBe(true);
  expect(roleHasPermission(ScopeType.SCHOOL, 'teacher', Permission.SCHOOL_ATTENDANCE_READ_ALL)).toBe(false);
  expect(roleHasPermission(ScopeType.SCHOOL, 'teacher', Permission.SCHOOL_ATTENDANCE_CORRECT)).toBe(false);
  for (const p of [Permission.SCHOOL_ATTENDANCE_MARK, Permission.SCHOOL_ATTENDANCE_READ_ALL, Permission.SCHOOL_ATTENDANCE_CORRECT]) {
    expect(roleHasPermission(ScopeType.SCHOOL, 'school_admin', p)).toBe(true);
    expect(roleHasPermission(ScopeType.PLATFORM, 'platform_admin', p)).toBe(false);
  }
});
