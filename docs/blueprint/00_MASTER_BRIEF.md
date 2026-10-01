# 00 — Master Product Brief

## 1. Product vision

Build a universal, multi-tenant Smart School Management System for government and private schools across Karnataka, starting with Classes 1–7. The startup operates the software platform. Each school manages its own academic operations; authorized district officers can review permitted school-level and aggregated information.

**Product principle:** One platform, many schools, isolated school data, configurable academic rules, role-based access.

## 2. Target users

- Platform Super Admin / support operator
- District Administrator / authorized Education Officer
- Principal / School Administrator
- Teacher
- Student
- Parent / Guardian
- Optional future roles: accountant, librarian, transport coordinator, school counsellor, data-entry operator, auditor

## 3. Initial scope

### Included
- School registration and verification workflow
- School code and student ID login with secure activation
- Parent account verification and parent–student linking
- Academic years, Classes 1–7, sections, subjects and teacher assignments
- Daily attendance and attendance correction history
- Timetables and schedule changes
- Homework, learning materials and attachments
- Holidays, circulars, school notices and district notices
- Configurable exams, class tests, marks, approval, publication and report cards
- Student, parent, teacher, school-admin and district dashboards
- School-wise and district-level authorized reports
- English and Kannada initially; architecture supports more languages
- Notifications, audit logs, imports, exports, backups and operational monitoring

### Deferred / optional
- Classes 8–12
- Fee collection and online payments
- Transport management and live bus tracking
- Library management
- Online examinations
- QR/RFID attendance
- Advanced analytics and AI
- Deep integrations with government systems (only after authorization and technical discovery)

## 4. Product assumptions

- The initial market is Karnataka, India.
- Both government and private schools are in scope.
- The system is designed for broad eventual adoption, but launch is staged through pilots and batches.
- Students use school code + student ID + password/PIN after a controlled activation process.
- Parents use verified phone number + OTP or another approved secure authentication flow.
- The web portal is the primary interface for school and district administration.
- Mobile apps serve students, parents and teachers. Role-specific web access may also be offered.
- Grading, exam types, school calendars, attendance sessions and report-card rules are configurable.
- No government endorsement or official integration is assumed unless formally approved.

## 5. Product outcomes

- Reduce manual attendance and report preparation.
- Give parents timely access to their own child's attendance, homework, timetable and published results.
- Help teachers complete recurring tasks efficiently.
- Help school administrators monitor daily operations.
- Provide authorized district reporting without unrestricted exposure of individual children's data.
- Keep historical academic records accurate and auditable.

## 6. Core architecture principles

- Modular monolith first; avoid premature microservices.
- One shared PostgreSQL database with enforced tenant isolation.
- REST API is the business-logic boundary for mobile and web.
- Server-side authorization for every protected operation.
- Explicit school membership, class assignment and guardian relationship checks.
- Database constraints prevent invalid and cross-school associations.
- Use transactions for attendance submission and marks publication.
- Private object storage for documents.
- Asynchronous queue for notifications, exports and scheduled tasks.
- Versioned academic configurations and auditable changes.
- Localization from the beginning; do not hardcode UI strings.

## 7. Product delivery strategy

Build complete vertical slices:
1. School creation → class setup → student enrollment → teacher assignment.
2. Teacher attendance → persisted record → parent sees only linked child's status.
3. Homework publishing → student/parent visibility → notification.
4. Exam setup → marks entry → review → publication → report card.
5. District summary → scoped report → authorized export.

## 8. AI coding instructions

When generating code from this brief:
- First inspect the repository and report its existing stack before modifying anything.
- Do not assume files, libraries, environment variables, or integrations exist.
- Propose a small implementation plan before a large change.
- Implement one vertical slice at a time.
- Include database migrations, validation, authorization and tests with each feature.
- Do not leave mock data in production flows.
- Do not claim a test passed unless it was run.
- Keep secrets out of source control.
- Do not weaken authorization to make a demo work.
- Prefer typed request/response schemas and centralized error handling.
- Update relevant documentation and `.env.example`.
- Ask before introducing paid external services or making irreversible data changes.
