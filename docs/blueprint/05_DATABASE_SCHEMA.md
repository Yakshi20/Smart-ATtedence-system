# 05 — Database Schema and Data Model

This is a logical schema. Exact SQL types, deletion policies, indexes and composite constraints must be finalized in migrations.

## 1. Tenancy and identity

| Table | Important columns / notes |
|---|---|
| `districts` | `id`, `name`, `state_code`, `status` |
| `administrative_areas` | `id`, `district_id`, `parent_area_id`, `name`, `area_type` |
| `schools` | `id`, `district_id`, `area_id`, `school_code`, `name`, `sector`, `status` |
| `school_profiles` | `school_id`, address, contact and recognition details |
| `users` | `id`, phone, email, display name, status, preferred language |
| `auth_identities` | `id`, `user_id`, provider, provider subject |
| `school_memberships` | `id`, `school_id`, `user_id`, role, status |
| `district_memberships` | `id`, `district_id`, `user_id`, role, status |
| `permissions` | `id`, permission key, description |
| `role_permissions` | role, permission ID |
| `user_sessions` | user, created/expiry/revocation timestamps |

## 2. Academic structure

| Table | Important columns / notes |
|---|---|
| `academic_years` | `id`, `school_id`, name, start/end dates, status |
| `grades` | `id`, `school_id`, grade number, display name |
| `sections` | `id`, `school_id`, academic year, grade, section name |
| `students` | `id`, `school_id`, school-scoped student number, name, status |
| `enrollments` | student, school, academic year, section, status |
| `guardians` | user, relationship type, verification status |
| `student_guardians` | student, guardian, relationship status, permissions |
| `teacher_profiles` | user, staff number, status |
| `subjects` | school, subject code, name, status |
| `class_subjects` | section, subject, academic year |
| `teacher_assignments` | teacher, class-subject assignment, dates/status if needed |

Keep students separate from academic-year enrollments so promotion and transfer do not overwrite historical records.

## 3. Attendance and calendar

| Table | Important columns / notes |
|---|---|
| `attendance_sessions` | school, academic year, section, date, session type, status |
| `attendance_records` | session, student, status, marker, timestamp |
| `attendance_change_log` | attendance record, old/new status, reason, actor, timestamp |
| `timetable_versions` | school, section, effective dates, status |
| `timetable_periods` | timetable version, weekday, period number, start/end |
| `timetable_entries` | period, class-subject, teacher assignment, room |
| `holidays` | school/district scope, title, date range |
| `calendar_events` | school, optional section, title, times, visibility |

Constraints:
- Unique attendance record per student/session.
- Attendance session must match the student's school and enrollment/section for that date.
- Do not treat missing attendance as absent automatically.
- Version timetables rather than overwriting published schedules without history.

## 4. Homework, files and notices

| Table | Important columns / notes |
|---|---|
| `assignments` | school, class-subject, title, description, due date, state |
| `assignment_targets` | assignment and target section |
| `assignment_attachments` | assignment and file |
| `files` | school, storage key, MIME type, size, uploader |
| `assignment_submissions` | assignment, student, submitted time, status |
| `announcements` | school/district scope, title/body, state, published time |
| `announcement_targets` | announcement and target section |

Files are private. Store opaque object keys rather than public paths. Validate file size/type and authorize each upload/download.

## 5. Exams and marks

| Table | Important columns / notes |
|---|---|
| `assessment_schemes` | school, academic year, name, version, status |
| `assessment_types` | scheme, name, weight, configuration |
| `examinations` | school, academic year, name, exam type, status |
| `exam_subjects` | examination, class-subject, maximum/pass marks, exam date |
| `student_marks` | exam subject, student, score, result status, entered by |
| `mark_change_log` | marks record, old/new value, reason, actor, timestamp |
| `result_publications` | examination, section, publisher, publication time |
| `report_cards` | student, academic year, publication, file reference |

Rules:
- Configurations are versioned.
- Scores are within the configured range.
- Support decimal scores when configured.
- Absent, exempt, incomplete and not-assessed are explicit statuses, not automatically numeric zero.
- Published results preserve the calculation scheme used.
- Corrections to published results require authorization and audit history.

## 6. Notifications, audit and governance

| Table | Important columns / notes |
|---|---|
| `notifications` | recipient, type, title/body, created time |
| `notification_deliveries` | notification, channel, status, delivered time |
| `device_tokens` | user, token, platform, revocation time |
| `audit_logs` | actor, school scope, action, entity type/ID, timestamp |
| `consent_records` | subject reference, guardian, purpose, status, recorded time |
| `data_requests` | request type, requester, status, resolution |
| `imports` | school, file, status, creator, error summary |
| `report_jobs` | requester, scope, status, output file |

Consent records must reflect a legally valid process where required; storing a row alone does not establish legal compliance.

## 7. Database engineering rules
- Use UUIDs or equivalent unpredictable public identifiers.
- Unique school code globally; unique student number within school.
- Use composite constraints to prevent cross-school relationships.
- Index school ID, academic year, section, student, date and examination fields used in common queries.
- Use foreign keys and explicit delete/update policies.
- Avoid hard deletion of published academic records; use correction and retention workflows.
- Scope background jobs and reports explicitly.
- Keep sensitive fields to the minimum necessary.
- Use migrations and test upgrades against realistic data.
