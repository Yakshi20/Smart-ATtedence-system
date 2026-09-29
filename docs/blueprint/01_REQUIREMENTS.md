# 01 — Product Requirements

## 1. Functional requirements

### FR-001 School onboarding
- Schools can submit registration requests.
- Platform or delegated authorized staff verify school details.
- Every approved school receives a unique platform school code.
- School status supports pending, active, suspended and archived.
- Government/private sector is metadata, not a permission shortcut.
- Keep verification evidence and approval history with restricted access.

### FR-002 Identity and account activation
- Students sign in with school code + student ID + password/PIN.
- Student activation requires a one-time credential or school-admin-approved process.
- Parents use verified phone/OTP or an approved identity workflow.
- Teachers and administrators have secure account activation and recovery.
- School code is not a secret and cannot by itself authorize access.
- Rate-limit authentication, OTP and recovery attempts.
- Sessions can expire and be revoked.

### FR-003 Academic structure
- Support academic years, grades 1–7, sections, subjects and school working calendars.
- Academic years and enrollments are historical records, not overwritten in place.
- Support student promotion, transfer, withdrawal and re-enrollment.
- A school can configure its own subjects, timetable and assessment scheme.

### FR-004 Students
- Maintain student number, name, enrollment status and minimal required profile data.
- Student number is unique within the school.
- Only authorized school staff can create or update student records.
- Students see their own personal records and materials shared with their class.
- Historical records remain access-controlled after transfer or graduation.

### FR-005 Parent/guardian management
- A student may have multiple verified guardians.
- A guardian may be linked to multiple children.
- Relationship verification is required before data access.
- Guardian permissions and relationship status can be reviewed and revoked.
- Each child profile must be independently authorized on every API request.
- Never trust a student ID supplied by a client without checking the relationship.

### FR-006 Teacher assignments
- Teachers are assigned to school, academic year, class/section and subject.
- Assignments have active dates/status where appropriate.
- Teachers can operate only on assigned records unless separately authorized.

### FR-007 Attendance
- Authorized teachers can open an attendance session for an assigned class/date.
- Load the enrolled roster for that session.
- Support configurable statuses such as present, absent, late, approved leave and other school-approved states.
- Support single or multiple sessions per day.
- Prevent duplicate student records for the same session.
- Unmarked is not automatically absent unless an explicitly approved school policy says so.
- Submission is transactional and retry-safe.
- Corrections record old/new values, reason, actor and timestamp.
- Attendance reports can be filtered by school, year, class, section and date range according to permissions.
- Parent alerts follow school notification policy and do not disclose other students.

### FR-008 Timetable and calendar
- Support versioned timetables with effective dates.
- Configure weekdays, periods, subjects, teachers, rooms and breaks.
- Publish schedule changes to targeted classes.
- Support school and district holidays, school closures, events and exam dates.
- Define precedence when district-wide and school calendars overlap.

### FR-009 Homework and materials
- Teachers create assignments for assigned class-subjects.
- Assignment includes title, instructions, publication state and optional due date.
- Allow validated attachments such as PDF and images.
- Students and linked parents can view published work targeted to the student.
- Optional submission workflow can be enabled later.
- Editing/cancelling published assignments is audited.

### FR-010 Announcements and notifications
- Support school, class/section and district scopes.
- Draft and publish states.
- Notifications can use in-app, push and SMS channels where configured.
- Queue notifications only after the related transaction succeeds.
- Track delivery state without exposing unnecessary personal information.
- Retry safely and prevent accidental duplicate sends where feasible.
- Keep sensitive academic details out of lock-screen text by default.

### FR-011 Examinations and grading
- Create configurable assessment schemes per school/academic year/grade where needed.
- Support class tests, unit tests, periodic assessments, term/midterm/final exams, projects and other configured types.
- Configure maximum marks, passing marks, weights, grade bands, rounding and exemptions.
- Validate marks against configured ranges.
- Represent absent, exempt, incomplete and not-assessed separately from numeric zero.
- Support draft, submitted, returned-for-correction, approved and published states.
- Students and parents see only published results.
- Preserve the scheme/version used for published calculations.
- Corrections to published marks require authorization, reason and audit history.
- Generate report cards from approved data.

### FR-012 School administration
- Manage staff, students, classes, sections, subjects, timetables and calendars.
- Monitor attendance completion and marks publication.
- Approve corrections according to policy.
- Import rosters using a validated spreadsheet template.
- Report row-level import errors and avoid partial corruption.
- Export only authorized data with audit logs.

### FR-013 District portal
- List schools within authorized district scope.
- Monitor enrollment totals, attendance submission status and exam completion.
- View aggregate school/class summaries where authorized.
- Individual student-level details require explicit permission and purpose.
- Publish district notices.
- Generate scoped exports and record who requested/downloaded them.
- District users do not automatically edit school records.

### FR-014 Platform operations
- Manage platform configuration, support and school onboarding.
- Access to academic data is not automatically granted by platform-admin role.
- Any exceptional support access must be limited, justified, approved where required, time-bound and audited.

### FR-015 Localization and accessibility
- English and Kannada are initial languages.
- Additional Indian languages can be added without code changes to business logic.
- All user-facing text comes from translation resources.
- Support readable typography, screen-reader labels, adequate contrast and accessible form controls.

## 2. Non-functional requirements

- Initial proposed uptime target: 99.5% monthly, subject to infrastructure and support budget.
- Common dashboard/timetable reads target under 2 seconds at p95 under a defined test load.
- Secure school-level tenant isolation.
- Reliable transactions for attendance and results.
- Automated backups and tested restoration.
- Monitoring, structured logs, error tracking and alerting.
- Versioned API and database migrations.
- Mobile compatibility matrix defined before release.
- Low-bandwidth experience; consider offline attendance only after core online workflows are stable.
- Data retention and deletion rules configurable to legal and contractual requirements.
- Privacy-preserving analytics and least-privilege staff access.

## 3. Out of scope for initial release
- Always-on student location tracking.
- Biometrics as a default attendance mechanism.
- Collecting Aadhaar by default.
- AI-generated grades or automated high-impact decisions.
- Unapproved government-system integration.
- Online fee payments unless separately specified and reviewed.
