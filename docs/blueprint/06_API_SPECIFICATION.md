# 06 — REST API Specification

Base prefix: `/api/v1`

All endpoints require authentication unless explicitly marked public. Every operation must enforce server-side permissions and resource scope.

## 1. Authentication
| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/auth/student/activate` | Activate student with school-issued credential |
| POST | `/auth/login` | Sign in |
| POST | `/auth/refresh` | Refresh session/token securely |
| POST | `/auth/logout` | Revoke current session |
| POST | `/auth/password/reset` | Initiate recovery |
| POST | `/auth/otp/request` | Request OTP for an eligible flow |
| POST | `/auth/otp/verify` | Verify OTP |
| GET | `/me` | Current profile and authorized roles |
| GET | `/me/schools` | Accessible school memberships |

## 2. School setup
| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/schools` | Submit registration request |
| GET | `/schools` | List schools visible to caller |
| GET | `/schools/{schoolId}` | Get authorized school |
| PATCH | `/schools/{schoolId}` | Update permitted settings |
| POST | `/schools/{schoolId}/academic-years` | Create academic year |
| POST | `/schools/{schoolId}/sections` | Configure sections |
| GET | `/schools/{schoolId}/classes` | List grades/sections |
| POST | `/schools/{schoolId}/students/import` | Start roster import |
| GET | `/schools/{schoolId}/imports/{importId}` | Import status/errors |
| POST | `/schools/{schoolId}/teacher-assignments` | Assign teacher |

## 3. Student and parent
| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/students/me` | Own profile |
| GET | `/students/me/timetable` | Own timetable |
| GET | `/students/me/attendance` | Own attendance |
| GET | `/students/me/homework` | Published assignments |
| GET | `/students/me/examinations` | Exam schedule |
| GET | `/students/me/results` | Published results |
| GET | `/parents/me/children` | Verified linked children |
| GET | `/parents/me/children/{studentId}/attendance` | Linked child's attendance |
| GET | `/parents/me/children/{studentId}/homework` | Linked child's homework |
| GET | `/parents/me/children/{studentId}/results` | Linked child's published results |
| POST | `/parents/me/children/{studentId}/leave-requests` | Request leave |

Validate the guardian relationship on every child-specific request. Avoid endpoints that enumerate student records based on IDs.

## 4. Attendance
| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/schools/{schoolId}/attendance/sessions` | Open session |
| GET | `/attendance/sessions/{sessionId}` | Get authorized register |
| PUT | `/attendance/sessions/{sessionId}/records` | Submit/update permitted records |
| POST | `/attendance/records/{recordId}/corrections` | Request/record correction |
| POST | `/attendance/sessions/{sessionId}/submit` | Submit register |
| POST | `/attendance/sessions/{sessionId}/approve` | Approve when required |
| GET | `/schools/{schoolId}/attendance/reports` | Authorized reports |

Batch requests validate every student and record. Use idempotency keys where retries are expected.

## 5. Homework, timetable and notices
| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/schools/{schoolId}/assignments` | Create homework |
| GET | `/assignments/{assignmentId}` | Read authorized assignment |
| PATCH | `/assignments/{assignmentId}` | Edit permitted assignment |
| POST | `/files/upload-requests` | Request secure upload URL |
| POST | `/schools/{schoolId}/timetables` | Create timetable version |
| POST | `/timetables/{timetableId}/publish` | Publish timetable |
| POST | `/schools/{schoolId}/holidays` | Create holiday |
| POST | `/schools/{schoolId}/announcements` | Create notice |
| POST | `/announcements/{announcementId}/publish` | Publish notice |

## 6. Exams and marks
| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/schools/{schoolId}/assessment-schemes` | Configure grading |
| POST | `/schools/{schoolId}/examinations` | Create examination |
| POST | `/examinations/{examId}/subjects` | Configure subjects and marks |
| GET | `/examinations/{examId}/marks` | Authorized marks grid |
| PUT | `/examinations/{examId}/marks` | Enter/update draft marks |
| POST | `/examinations/{examId}/submit-for-review` | Submit marks |
| POST | `/examinations/{examId}/approve` | Approve results |
| POST | `/examinations/{examId}/publish` | Publish results |
| GET | `/schools/{schoolId}/examinations/reports` | Authorized exam reports |
| GET | `/students/{studentId}/report-cards/{yearId}` | Authorized report card |

## 7. District reporting
| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/districts/{districtId}/schools` | Authorized school list |
| GET | `/districts/{districtId}/attendance-summary` | Aggregate attendance |
| GET | `/districts/{districtId}/enrollment-summary` | Aggregate enrollment |
| GET | `/districts/{districtId}/exam-status` | Exam completion status |
| GET | `/districts/{districtId}/academic-summary` | Permitted academic summaries |
| POST | `/districts/{districtId}/reports` | Request export |
| GET | `/reports/{reportId}` | Check job / retrieve authorized report |

## 8. API conventions
- Use consistent JSON responses and structured error codes.
- `200` success; `201` created; `202` asynchronous job accepted.
- `400` invalid request; `401` unauthenticated; `403` unauthorized; `404` may be used to avoid resource enumeration; `409` state conflict; `422` business validation error; `429` rate limit.
- Use pagination and stable sorting.
- Use request/correlation IDs.
- Never expose stack traces, storage paths, secrets or unrelated student data.
- Validate schemas at boundaries and recheck authorization inside the service layer.
- Generate and maintain OpenAPI documentation.
