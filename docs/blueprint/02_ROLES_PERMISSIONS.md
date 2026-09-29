# 02 — Roles, Permissions and Tenant Isolation

## 1. Roles

### Platform Super Admin
Manages platform configuration, onboarding, operational health and support. Does not automatically receive unrestricted access to student academic records.

### District Administrator / Officer
Access is limited to assigned district(s), delegated duties and approved purposes. Default access is aggregate reporting and school oversight.

### Principal / School Administrator
Manages one school or explicitly assigned schools, including academic setup, staff, enrollment, calendars, approvals and school reports.

### Teacher
Can view and operate on assigned classes, subjects and students. Specific abilities (attendance, homework, marks) are separately permissioned.

### Student
Can view own profile, timetable, attendance, homework, notices and published results.

### Parent / Guardian
Can view records of verified linked children and perform explicitly permitted actions such as leave requests.

### Optional roles
Data-entry operator, accountant, librarian, transport coordinator, auditor. Add only when workflows require them; define least-privilege permissions.

## 2. Authorization model

Use RBAC plus relationship/attribute checks:
- role and permission
- active school membership
- district scope
- academic year and enrollment status
- teacher assignment
- guardian–student relationship
- record publication status
- action-specific approval authority

Never use role name alone to authorize access to an object.

## 3. Permission matrix

| Capability | Platform admin | District officer | Principal | Teacher | Student | Parent |
|---|---|---|---|---|---|---|
| Platform configuration | Full | None | None | None | None | None |
| School registration | Manage/verify | If delegated | Request/own setup | None | None | None |
| Manage school staff | Operational support only | Limited | Own school | None | None | None |
| Manage class rosters | Exceptional support only | Aggregate/limited | Own school | Assigned if granted | None | None |
| Mark attendance | None by default | View/audit if authorized | Own school | Assigned | Own view | Linked view |
| Correct attendance | Exceptional audited process | Audit if authorized | Own school approval | Request or limited correction | None | None |
| Enter marks | None by default | View/audit if authorized | Review/manage | Assigned | None | None |
| Publish marks | None by default | Oversight if authorized | Authorized approver | Only if explicitly granted | None | None |
| View homework | Support only when authorized | Aggregate if needed | Own school | Assigned | Published target | Published target for linked child |
| View district summary | Platform operations | Assigned district | Own school only | Assigned summaries | None | None |
| Access another school | No routine access | Only if explicitly authorized | No | No | No | No |
| Access another child | No routine access | Only if explicitly authorized | School-duty basis only | Assignment basis only | No | No |

## 4. Tenant isolation rules
1. Every school-owned record must have an unambiguous school scope.
2. Every request checks the authenticated user's active membership.
3. Client-supplied school ID is not proof of authorization.
4. Validate parent-child relationships on every child-specific request.
5. Validate teacher assignment for every class/subject operation.
6. Use composite foreign keys or equivalent constraints to prevent cross-school links.
7. Consider PostgreSQL row-level security as defense in depth.
8. Ensure background jobs and exports use explicit tenant scope.
9. Test cross-tenant access with automated negative tests.
10. Log sensitive administrative access and exports.

## 5. Student and parent privacy rules
- A parent can have multiple linked children.
- A child can have multiple verified guardians according to school policy.
- Parent linking requires verification and an auditable status.
- Revoked guardian links immediately stop future access.
- Student and parent roles cannot modify official attendance or marks.
- Student IDs and school codes must not enable account enumeration.
- Avoid sensitive details in push notification previews.
