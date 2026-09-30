-- Slice 4 — attendance.
--
-- Decisions referenced (docs/decisions/00_ANALYSIS_AND_OPEN_DECISIONS.md):
--   Q1    attendance is per period and subject: a session belongs to a class_subject
--   D-10  several sessions per day, discriminated by period
--   D-11  an unmarked pupil has NO record; absence of a row means "not marked", never "absent"
--   D-12  the roster is the set of enrolments covering the session date
--
-- Integrity model:
--   * Composite keys tie every session to its class-subject's school, year and section, and
--     every record to its session's section and to the pupil's enrolment in that section.
--   * A record may only reference an enrolment that is live and covers the session date.
--   * Records are never deleted; their status changes only together with an appended correction
--     row carrying the old value, new value, reason, actor and time.
--   * Enrolment history can no longer be changed in a way that strands recorded attendance.
--
-- 0001–0003 are untouched. The two ALTERs below only add unique keys to existing tables so they
-- can be targets of composite foreign keys.

------------------------------------------------------------------------------------------
-- Composite-key targets on existing tables
------------------------------------------------------------------------------------------

ALTER TABLE class_subjects
  ADD CONSTRAINT class_subjects_id_school_year_section_key UNIQUE (id, school_id, academic_year_id, section_id);

ALTER TABLE enrollments
  ADD CONSTRAINT enrollments_id_school_section_student_key UNIQUE (id, school_id, section_id, student_id);

------------------------------------------------------------------------------------------
-- Sessions
------------------------------------------------------------------------------------------

CREATE TABLE attendance_sessions (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id                 uuid NOT NULL,
  academic_year_id          uuid NOT NULL,
  section_id                uuid NOT NULL,
  class_subject_id          uuid NOT NULL,
  session_date              date NOT NULL,
  -- Timetable slot within the day (D-10). Bell times are not modelled until timetables exist.
  period                    smallint NOT NULL,
  status                    text NOT NULL DEFAULT 'open',
  created_by                uuid REFERENCES users (id) ON DELETE RESTRICT,
  created_at                timestamptz NOT NULL DEFAULT now(),
  submitted_by              uuid REFERENCES users (id) ON DELETE RESTRICT,
  submitted_at              timestamptz,
  -- Retry safety for the one submission a session accepts: the client's key and a SHA-256 of the
  -- canonical payload. A repeat with the same key and payload is answered from the stored result.
  submit_idempotency_key    uuid,
  submit_payload_hash       bytea,

  CONSTRAINT attendance_sessions_school_fk FOREIGN KEY (school_id) REFERENCES schools (id) ON DELETE RESTRICT,
  -- Section and year are those of the class-subject, within one school.
  CONSTRAINT attendance_sessions_class_subject_fk
    FOREIGN KEY (class_subject_id, school_id, academic_year_id, section_id)
    REFERENCES class_subjects (id, school_id, academic_year_id, section_id) ON DELETE RESTRICT,
  CONSTRAINT attendance_sessions_period_range CHECK (period BETWEEN 1 AND 12),
  CONSTRAINT attendance_sessions_status_valid CHECK (status IN ('open', 'submitted')),
  CONSTRAINT attendance_sessions_submission_complete CHECK (
    (status = 'open' AND submitted_at IS NULL AND submitted_by IS NULL
                     AND submit_idempotency_key IS NULL AND submit_payload_hash IS NULL)
 OR (status = 'submitted' AND submitted_at IS NOT NULL AND submitted_by IS NOT NULL
                          AND submit_idempotency_key IS NOT NULL AND octet_length(submit_payload_hash) = 32)
  ),
  -- One register per section per period per day.
  CONSTRAINT attendance_sessions_slot_key UNIQUE (section_id, session_date, period),
  CONSTRAINT attendance_sessions_id_school_section_key UNIQUE (id, school_id, section_id)
);
CREATE INDEX attendance_sessions_school_date_idx ON attendance_sessions (school_id, session_date);
CREATE INDEX attendance_sessions_class_subject_idx ON attendance_sessions (class_subject_id, session_date);

CREATE FUNCTION attendance_sessions_check_date() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  y_start date;
  y_end date;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.session_date IS DISTINCT FROM OLD.session_date
     OR NEW.section_id IS DISTINCT FROM OLD.section_id
     OR NEW.class_subject_id IS DISTINCT FROM OLD.class_subject_id
     OR NEW.period IS DISTINCT FROM OLD.period
     OR NEW.school_id IS DISTINCT FROM OLD.school_id
     OR (OLD.status = 'submitted' AND (NEW.status IS DISTINCT FROM OLD.status
         OR NEW.submit_idempotency_key IS DISTINCT FROM OLD.submit_idempotency_key
         OR NEW.submit_payload_hash IS DISTINCT FROM OLD.submit_payload_hash
         OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at))) THEN
    RAISE EXCEPTION 'attendance session identity and submission are immutable'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT start_date, end_date INTO y_start, y_end FROM academic_years WHERE id = NEW.academic_year_id;
  IF NEW.session_date < y_start OR NEW.session_date > y_end THEN
    RAISE EXCEPTION 'attendance date falls outside the academic year'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'attendance_sessions_within_academic_year';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER attendance_sessions_date_and_identity
  BEFORE INSERT OR UPDATE ON attendance_sessions
  FOR EACH ROW EXECUTE FUNCTION attendance_sessions_check_date();

CREATE FUNCTION attendance_sessions_forbid_delete() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'attendance sessions are never deleted' USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER attendance_sessions_no_delete
  BEFORE DELETE ON attendance_sessions
  FOR EACH ROW EXECUTE FUNCTION attendance_sessions_forbid_delete();

------------------------------------------------------------------------------------------
-- Records
------------------------------------------------------------------------------------------

CREATE TABLE attendance_records (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id      uuid NOT NULL,
  session_id     uuid NOT NULL,
  section_id     uuid NOT NULL,
  student_id     uuid NOT NULL,
  enrollment_id  uuid NOT NULL,
  status         text NOT NULL,
  -- 0 = as submitted; incremented by each correction (see attendance_corrections.revision).
  revision       integer NOT NULL DEFAULT 0,
  marked_by      uuid REFERENCES users (id) ON DELETE RESTRICT,
  marked_at      timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT attendance_records_session_fk FOREIGN KEY (session_id, school_id, section_id)
    REFERENCES attendance_sessions (id, school_id, section_id) ON DELETE RESTRICT,
  -- The pupil's enrolment must be in the session's section (and school).
  CONSTRAINT attendance_records_enrollment_fk FOREIGN KEY (enrollment_id, school_id, section_id, student_id)
    REFERENCES enrollments (id, school_id, section_id, student_id) ON DELETE RESTRICT,
  CONSTRAINT attendance_records_status_valid CHECK (status IN ('present', 'absent', 'late', 'approved_leave')),
  CONSTRAINT attendance_records_revision_nonnegative CHECK (revision >= 0),
  CONSTRAINT attendance_records_session_student_key UNIQUE (session_id, student_id),
  CONSTRAINT attendance_records_id_school_key UNIQUE (id, school_id)
);
CREATE INDEX attendance_records_student_idx ON attendance_records (student_id);
CREATE INDEX attendance_records_enrollment_idx ON attendance_records (enrollment_id);

-- Insert: the enrolment must be live and cover the session date (D-12).
-- Update: identity is immutable; status may change only with the matching correction row.
-- Delete: never.
CREATE FUNCTION attendance_records_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  s_date date;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'attendance records are never deleted; correct them instead'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT session_date INTO s_date FROM attendance_sessions WHERE id = NEW.session_id;
    IF NOT EXISTS (
      SELECT 1 FROM enrollments e
      WHERE e.id = NEW.enrollment_id
        AND e.voided_at IS NULL
        AND e.effective_from <= s_date
        AND (e.effective_to IS NULL OR e.effective_to > s_date)
    ) THEN
      RAISE EXCEPTION 'the enrolment does not cover the session date'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'attendance_records_enrollment_covers_date';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.school_id IS DISTINCT FROM OLD.school_id
     OR NEW.session_id IS DISTINCT FROM OLD.session_id
     OR NEW.section_id IS DISTINCT FROM OLD.section_id
     OR NEW.student_id IS DISTINCT FROM OLD.student_id
     OR NEW.enrollment_id IS DISTINCT FROM OLD.enrollment_id
     OR NEW.marked_by IS DISTINCT FROM OLD.marked_by
     OR NEW.marked_at IS DISTINCT FROM OLD.marked_at THEN
    RAISE EXCEPTION 'attendance record identity is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status OR NEW.revision IS DISTINCT FROM OLD.revision THEN
    IF NEW.revision <> OLD.revision + 1 OR NOT EXISTS (
      SELECT 1 FROM attendance_corrections c
      WHERE c.record_id = NEW.id AND c.revision = NEW.revision
        AND c.old_status IS NOT DISTINCT FROM OLD.status AND c.new_status = NEW.status
    ) THEN
      RAISE EXCEPTION 'attendance status changes only through a recorded correction'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

------------------------------------------------------------------------------------------
-- Corrections
------------------------------------------------------------------------------------------

-- Append-only history of every change after submission. `old_status` NULL means the pupil had
-- no record (was unmarked, D-11) and the correction created one.
CREATE TABLE attendance_corrections (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id     uuid NOT NULL,
  record_id     uuid NOT NULL,
  revision      integer NOT NULL,
  old_status    text,
  new_status    text NOT NULL,
  reason        text NOT NULL,
  corrected_by  uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  corrected_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT attendance_corrections_record_fk FOREIGN KEY (record_id, school_id)
    REFERENCES attendance_records (id, school_id) ON DELETE RESTRICT,
  CONSTRAINT attendance_corrections_status_valid CHECK (
    new_status IN ('present', 'absent', 'late', 'approved_leave')
    AND (old_status IS NULL OR old_status IN ('present', 'absent', 'late', 'approved_leave'))
  ),
  CONSTRAINT attendance_corrections_changes_something CHECK (old_status IS DISTINCT FROM new_status),
  CONSTRAINT attendance_corrections_reason_present CHECK (btrim(reason) <> '' AND char_length(reason) <= 500),
  CONSTRAINT attendance_corrections_revision_positive CHECK (revision >= 1),
  CONSTRAINT attendance_corrections_record_revision_key UNIQUE (record_id, revision)
);
CREATE INDEX attendance_corrections_school_time_idx ON attendance_corrections (school_id, corrected_at);

-- Created after attendance_corrections, which its function body references.
CREATE TRIGGER attendance_records_integrity
  BEFORE INSERT OR UPDATE OR DELETE ON attendance_records
  FOR EACH ROW EXECUTE FUNCTION attendance_records_guard();

CREATE FUNCTION attendance_corrections_append_only() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'attendance_corrections is append-only (% rejected)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER attendance_corrections_immutable
  BEFORE UPDATE OR DELETE ON attendance_corrections
  FOR EACH ROW EXECUTE FUNCTION attendance_corrections_append_only();

------------------------------------------------------------------------------------------
-- Enrolment history may not strand recorded attendance
------------------------------------------------------------------------------------------

-- Voiding says a placement never happened, and ending one says the pupil left the section on a
-- date; either would contradict attendance already recorded against that placement. Such a
-- change must be refused, whichever code path attempts it.
CREATE FUNCTION enrollments_protect_attendance() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.voided_at IS NULL AND NEW.voided_at IS NOT NULL
     AND EXISTS (SELECT 1 FROM attendance_records r WHERE r.enrollment_id = OLD.id) THEN
    RAISE EXCEPTION 'this enrolment has recorded attendance and cannot be voided'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'enrollments_attendance_blocks_void';
  END IF;

  IF OLD.effective_to IS NULL AND NEW.effective_to IS NOT NULL AND EXISTS (
       SELECT 1 FROM attendance_records r
       JOIN attendance_sessions s ON s.id = r.session_id
       WHERE r.enrollment_id = OLD.id AND s.session_date >= NEW.effective_to
     ) THEN
    RAISE EXCEPTION 'attendance is recorded on or after this date; the enrolment cannot end earlier'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'enrollments_attendance_blocks_end';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER enrollments_protect_attendance
  BEFORE UPDATE ON enrollments
  FOR EACH ROW EXECUTE FUNCTION enrollments_protect_attendance();
