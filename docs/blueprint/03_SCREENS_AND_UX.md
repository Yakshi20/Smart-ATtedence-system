# 03 — Screen Inventory and UX

## 1. Public website and platform administration
- Landing page and product overview
- School registration request
- School verification and approval queue
- District/administrative-area management
- School directory and status
- Platform subscription/billing (if applicable)
- Support and platform operations dashboard
- Security/audit event viewer
- Platform settings and language configuration

## 2. Student mobile app
- Login: school code + student ID + password/PIN
- Controlled account activation
- Password/PIN recovery
- Home dashboard
- Profile and school details
- Today/weekly timetable
- Homework list and detail
- Notes and learning-material downloads
- Attendance summary and history
- Examination calendar
- Subject-wise marks and class-test results
- Published report cards
- Holidays and school calendar
- Notices and circulars
- Language/accessibility settings
- Help and logout

## 3. Parent mobile app
- Phone verification and account activation
- Linked children selector
- Child profile and class
- Attendance summary/history
- Timetable and schedule changes
- Homework and due dates
- Published marks and report cards
- Examination schedules
- Holidays and announcements
- Absence/result notifications
- Leave request and status
- Parent-teacher meeting details
- School contact directory
- Optional fees/receipts
- Guardian relationship management requests
- Language, privacy and logout

## 4. Teacher portal
- Dashboard and assigned classes
- Class/section roster
- Attendance register
- Attendance correction request
- Timetable and subject view
- Homework create/edit/publish
- Learning material upload
- Exam/class test creation (authorized roles only)
- Marks entry grid
- Draft/submitted/returned marks
- Assigned student academic history
- Class announcements
- Approved parent communication
- Attendance and marks reports
- Profile and account security

## 5. Principal / school administrator portal
- School overview
- School profile and verification
- Academic year setup
- Class/section management
- Admissions and enrollment
- Transfer/withdrawal
- Teacher and staff accounts
- Teacher-to-class/subject assignment
- Parent-child link verification
- Attendance monitoring and correction approvals
- Timetable and period management
- Holiday/calendar management
- Exam and grading configuration
- Exam schedule management
- Marks review/publication
- Report-card templates
- Homework and notice management
- School-wide reports
- Controlled student-record exports
- School audit logs and account management

## 6. District portal
- District overview
- School onboarding/approval
- School directory and administrative hierarchy
- Enrollment summaries by school/grade
- Attendance submission status
- School-wise attendance summaries
- Exam completion monitoring
- Published exam summaries
- Missing/overdue data reports
- District circulars and holiday notices
- Authorized comparison reports
- Excel/PDF exports
- Audit/access history
- District user permissions

## 7. UX principles
- Keep student and parent dashboards simple and readable.
- Use role-specific navigation; do not show irrelevant admin tools.
- Use clear status labels: draft, submitted, approved, published, returned.
- Show the effective date for timetable versions and school notices.
- Confirm irreversible or sensitive actions.
- Provide loading, empty, error, offline and session-expired states.
- Show when offline changes are pending; do not imply they were submitted.
- Keep all interface strings in translation files.
- Support Kannada text layout and suitable fonts.
- Use accessible controls and readable contrast.
- Avoid clutter and excessive charts on student-facing screens.

## 8. Core navigation suggestion

### Student
Home | Timetable | Homework | Attendance | Results | Notices/Profile

### Parent
Home | Children | Attendance | Homework | Results | Notices/Profile

### Teacher
Dashboard | Classes | Attendance | Homework | Exams/Marks | Notices/Profile

### School admin
Overview | Students | Staff | Academics | Attendance | Exams | Calendar/Notices | Reports | Settings

### District
Overview | Schools | Attendance | Academics | Notices | Reports | Users/Audit
