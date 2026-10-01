-- Slice 2 — academic structure, students, enrolments and teacher assignments.
--
-- Decisions referenced (docs/decisions/00_ANALYSIS_AND_OPEN_DECISIONS.md):
--   D-12  enrolments carry effective dates; overlapping placements are rejected
--   D-13  student status gates the person, enrolment gates academic participation
--   Q1    attendance is per period/subject, so teachers are assigned to class_subjects
--
-- Tenant isolation pattern: every school-owned table carries `school_id` and exposes
-- UNIQUE (id, school_id[, academic_year_id]) as the target of composite foreign keys from its
-- children. A row linking school A's student to school B's section, or a section of one
-- academic year to a class-subject of another, is therefore unrepresentable — the database
-- refuses it even if an application bug, a migration or a psql session tries.

-- Needed so an EXCLUDE constraint can combine equality on uuid with overlap on a date range.
-- Trusted extension since PostgreSQL 13: the database owner may create it.
CREATE EXTENSION IF NOT EXISTS btree_gist;

------------------------------------------------------------------------------------------
-- Academic years
------------------------------------------------------------------------------------------

CREATE TABLE academic_years (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id   uuid NOT NULL REFERENCES schools (id) ON DELETE RESTRICT,
  name        text NOT NULL,
  -- Both inclusive: a year of 2026-06-01..2027-03-31 includes 31 March.
  start_date  date NOT NULL,
  end_date    date NOT NULL,
  status      text NOT NULL DEFAULT 'planned',
  created_by  uuid REFERENCES users (id) ON DELETE RESTRICT,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT academic_years_name_present CHECK (btrim(name) <> '' AND char_length(name) <= 60),
  CONSTRAINT academic_years_dates_ordered CHECK (end_date > start_date),
  -- A school year longer than ~18 months is a data-entry error, not a real configuration.
  CONSTRAINT academic_years_span_reasonable CHECK (end_date - start_date <= 550),
  CONSTRAINT academic_years_status_valid CHECK (status IN ('planned', 'active', 'closed', 'archived')),
  CONSTRAINT academic_years_school_name_key UNIQUE (school_id, name),
  CONSTRAINT academic_years_id_school_key UNIQUE (id, school_id),
  -- Two years of one school may never cover the same day: roster resolution by date (D-12)
  -- must have exactly one answer.
  CONSTRAINT academic_years_no_overlap EXCLUDE USING gist (
    school_id WITH =,
    daterange(start_date, end_date, '[]') WITH &&
  )
);
-- At most one year is open for day-to-day work at a time.
CREATE UNIQUE INDEX academic_years_one_active_per_school
  ON academic_years (school_id) WHERE status = 'active';

------------------------------------------------------------------------------------------
-- Grades (classes) and sections
------------------------------------------------------------------------------------------

-- The classes a school offers. Not per year: "Class 5" is a stable property of the school.
CREATE TABLE grades (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id     uuid NOT NULL REFERENCES schools (id) ON DELETE RESTRICT,
  grade_number  smallint NOT NULL,
  display_name  text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  -- Launch scope is Classes 1–7 (blueprint 00). Widening is a one-line migration.
  CONSTRAINT grades_number_in_scope CHECK (grade_number BETWEEN 1 AND 7),
  CONSTRAINT grades_display_name_present CHECK (btrim(display_name) <> '' AND char_length(display_name) <= 60),
  CONSTRAINT grades_school_number_key UNIQUE (school_id, grade_number),
  CONSTRAINT grades_id_school_key UNIQUE (id, school_id)
);

CREATE TABLE sections (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id         uuid NOT NULL,
  academic_year_id  uuid NOT NULL,
  grade_id          uuid NOT NULL,
  -- Free text chosen by the school: "A", "B", "Kaveri", "Tunga" — no fixed naming scheme.
  name              text NOT NULL,
  created_by        uuid REFERENCES users (id) ON DELETE RESTRICT,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT sections_school_fk FOREIGN KEY (school_id) REFERENCES schools (id) ON DELETE RESTRICT,
  CONSTRAINT sections_year_same_school_fk FOREIGN KEY (academic_year_id, school_id)
    REFERENCES academic_years (id, school_id) ON DELETE RESTRICT,
  CONSTRAINT sections_grade_same_school_fk FOREIGN KEY (grade_id, school_id)
    REFERENCES grades (id, school_id) ON DELETE RESTRICT,
  CONSTRAINT sections_name_present CHECK (btrim(name) <> '' AND char_length(name) <= 40),
  CONSTRAINT sections_id_school_key UNIQUE (id, school_id),
  CONSTRAINT sections_id_school_year_key UNIQUE (id, school_id, academic_year_id)
);
-- "A" and "a" are the same section to a human reader.
CREATE UNIQUE INDEX sections_year_grade_name_key
  ON sections (academic_year_id, grade_id, lower(name));
CREATE INDEX sections_school_year_idx ON sections (school_id, academic_year_id);

------------------------------------------------------------------------------------------
-- Subjects
------------------------------------------------------------------------------------------

CREATE TABLE subjects (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id          uuid NOT NULL REFERENCES schools (id) ON DELETE RESTRICT,
  -- Short stable code for reports and imports, e.g. KAN, ENG, MATH, EVS.
  code               text NOT NULL,
  -- The school's primary label, in whatever language the school wrote it.
  name               text NOT NULL,
  -- Optional labels per UI language: {"en": "Mathematics", "kn": "ಗಣಿತ"}. Adding a language
  -- means widening the key list below and the shared schema; no table change.
  name_translations  jsonb NOT NULL DEFAULT '{}'::jsonb,
  status             text NOT NULL DEFAULT 'active',
  created_by         uuid REFERENCES users (id) ON DELETE RESTRICT,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT subjects_code_format CHECK (code ~ '^[A-Z][A-Z0-9_]{1,15}$'),
  CONSTRAINT subjects_name_present CHECK (btrim(name) <> '' AND char_length(name) <= 100),
  CONSTRAINT subjects_translations_object CHECK (jsonb_typeof(name_translations) = 'object'),
  CONSTRAINT subjects_translations_known_languages CHECK ((name_translations - ARRAY['en', 'kn']) = '{}'::jsonb),
  CONSTRAINT subjects_status_valid CHECK (status IN ('active', 'retired')),
  CONSTRAINT subjects_school_code_key UNIQUE (school_id, code),
  CONSTRAINT subjects_id_school_key UNIQUE (id, school_id)
);

-- A subject taught to one section in one year. Per-subject attendance (Q1) and teacher
-- assignments hang off this row.
CREATE TABLE class_subjects (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id         uuid NOT NULL,
  academic_year_id  uuid NOT NULL,
  section_id        uuid NOT NULL,
  subject_id        uuid NOT NULL,
  created_by        uuid REFERENCES users (id) ON DELETE RESTRICT,
  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT class_subjects_school_fk FOREIGN KEY (school_id) REFERENCES schools (id) ON DELETE RESTRICT,
  -- The section must belong to this school AND this academic year.
  CONSTRAINT class_subjects_section_same_school_year_fk FOREIGN KEY (section_id, school_id, academic_year_id)
    REFERENCES sections (id, school_id, academic_year_id) ON DELETE RESTRICT,
  CONSTRAINT class_subjects_subject_same_school_fk FOREIGN KEY (subject_id, school_id)
    REFERENCES subjects (id, school_id) ON DELETE RESTRICT,
  CONSTRAINT class_subjects_section_subject_key UNIQUE (section_id, subject_id),
  CONSTRAINT class_subjects_id_school_year_key UNIQUE (id, school_id, academic_year_id)
);
CREATE INDEX class_subjects_school_year_idx ON class_subjects (school_id, academic_year_id);

------------------------------------------------------------------------------------------
-- Students
------------------------------------------------------------------------------------------

-- The person as known to one school. Separate from enrolment so promotion and transfer never
-- rewrite identity. Deliberately minimal (07 §4): no Aadhaar, no biometrics, no address, no
-- guardian data here. `user_id` for student login (D-05) arrives with the login slice.
CREATE TABLE students (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id       uuid NOT NULL REFERENCES schools (id) ON DELETE RESTRICT,
  -- School-issued identifier; unique within the school only. Not a secret (non-negotiable 8).
  student_number  text NOT NULL,
  full_name       text NOT NULL,
  date_of_birth   date,
  status          text NOT NULL DEFAULT 'active',
  status_changed_at timestamptz,
  created_by      uuid REFERENCES users (id) ON DELETE RESTRICT,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT students_number_format CHECK (student_number ~ '^[A-Z0-9][A-Z0-9/-]{0,31}$'),
  CONSTRAINT students_full_name_present CHECK (btrim(full_name) <> '' AND char_length(full_name) <= 120),
  CONSTRAINT students_dob_plausible CHECK (date_of_birth IS NULL OR date_of_birth >= DATE '1990-01-01'),
  CONSTRAINT students_status_valid CHECK (status IN ('active', 'transferred', 'withdrawn')),
  CONSTRAINT students_school_number_key UNIQUE (school_id, student_number),
  CONSTRAINT students_id_school_key UNIQUE (id, school_id)
);
CREATE INDEX students_school_status_idx ON students (school_id, status, full_name);

-- Per-school counter for server-generated student numbers. A row lock on it serializes
-- generation within one school without serializing across schools.
CREATE TABLE student_number_counters (
  school_id   uuid PRIMARY KEY REFERENCES schools (id) ON DELETE RESTRICT,
  next_value  integer NOT NULL DEFAULT 1,

  CONSTRAINT student_number_counters_positive CHECK (next_value >= 1)
);

------------------------------------------------------------------------------------------
-- Enrolments
------------------------------------------------------------------------------------------

-- One row per placement of a student in a section. History is kept by ending a row and
-- opening another, never by editing one:
--   * [effective_from, effective_to) is half-open; NULL effective_to = still current.
--   * A mistaken row is voided (voided_at + reason), not deleted.
--   * Triggers below forbid DELETE and any change to a row's placement.
CREATE TABLE enrollments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id         uuid NOT NULL,
  student_id        uuid NOT NULL,
  academic_year_id  uuid NOT NULL,
  section_id        uuid NOT NULL,
  effective_from    date NOT NULL,
  effective_to      date,
  end_reason        text,
  voided_at         timestamptz,
  void_reason       text,
  previous_enrollment_id uuid REFERENCES enrollments (id) ON DELETE RESTRICT,
  created_by        uuid REFERENCES users (id) ON DELETE RESTRICT,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT enrollments_school_fk FOREIGN KEY (school_id) REFERENCES schools (id) ON DELETE RESTRICT,
  CONSTRAINT enrollments_student_same_school_fk FOREIGN KEY (student_id, school_id)
    REFERENCES students (id, school_id) ON DELETE RESTRICT,
  -- Section, school and academic year must all agree.
  CONSTRAINT enrollments_section_same_school_year_fk FOREIGN KEY (section_id, school_id, academic_year_id)
    REFERENCES sections (id, school_id, academic_year_id) ON DELETE RESTRICT,
  CONSTRAINT enrollments_dates_ordered CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT enrollments_end_reason_valid CHECK (
    end_reason IN ('section_transfer', 'promoted', 'withdrawn', 'transferred_out')
  ),
  CONSTRAINT enrollments_end_complete CHECK ((effective_to IS NULL) = (end_reason IS NULL)),
  CONSTRAINT enrollments_void_complete CHECK (
    (voided_at IS NULL) = (void_reason IS NULL)
    AND (void_reason IS NULL OR (btrim(void_reason) <> '' AND char_length(void_reason) <= 500))
  ),
  -- A student is in at most one section on any given day of a year. Voided rows are history,
  -- not placements, so they are excluded.
  CONSTRAINT enrollments_no_overlap EXCLUDE USING gist (
    student_id WITH =,
    academic_year_id WITH =,
    daterange(effective_from, effective_to, '[)') WITH &&
  ) WHERE (voided_at IS NULL)
);
-- The "current placement" per student and year, stated directly.
CREATE UNIQUE INDEX enrollments_one_open_per_student_year
  ON enrollments (student_id, academic_year_id)
  WHERE effective_to IS NULL AND voided_at IS NULL;
CREATE INDEX enrollments_section_dates_idx ON enrollments (section_id, effective_from, effective_to)
  WHERE voided_at IS NULL;
CREATE INDEX enrollments_student_idx ON enrollments (student_id);

-- Enrolment dates must lie inside the academic year. A trigger rather than a CHECK because the
-- bounds live on another row.
CREATE FUNCTION enrollments_check_within_year() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  y_start date;
  y_end date;
BEGIN
  SELECT start_date, end_date INTO y_start, y_end
    FROM academic_years WHERE id = NEW.academic_year_id;
  IF NEW.effective_from < y_start OR NEW.effective_from > y_end
     OR (NEW.effective_to IS NOT NULL AND NEW.effective_to > y_end + 1) THEN
    RAISE EXCEPTION 'enrolment dates fall outside the academic year'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'enrollments_within_academic_year';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER enrollments_within_academic_year
  BEFORE INSERT OR UPDATE ON enrollments
  FOR EACH ROW EXECUTE FUNCTION enrollments_check_within_year();

-- History protection: a placement, once written, is permanent. Only ending an open row and
-- voiding a live row are allowed, each exactly once.
CREATE FUNCTION enrollments_protect_history() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'enrollments are never deleted; void the row instead'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.school_id IS DISTINCT FROM OLD.school_id
     OR NEW.student_id IS DISTINCT FROM OLD.student_id
     OR NEW.academic_year_id IS DISTINCT FROM OLD.academic_year_id
     OR NEW.section_id IS DISTINCT FROM OLD.section_id
     OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
     OR NEW.previous_enrollment_id IS DISTINCT FROM OLD.previous_enrollment_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR (OLD.effective_to IS NOT NULL AND NEW.effective_to IS DISTINCT FROM OLD.effective_to)
     OR (OLD.end_reason IS NOT NULL AND NEW.end_reason IS DISTINCT FROM OLD.end_reason)
     OR (OLD.voided_at IS NOT NULL AND (NEW.voided_at IS DISTINCT FROM OLD.voided_at
                                        OR NEW.void_reason IS DISTINCT FROM OLD.void_reason))
  THEN
    RAISE EXCEPTION 'enrollment history is immutable; end or void the row and create a new one'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER enrollments_history_immutable
  BEFORE UPDATE OR DELETE ON enrollments
  FOR EACH ROW EXECUTE FUNCTION enrollments_protect_history();

------------------------------------------------------------------------------------------
-- Teacher assignments
------------------------------------------------------------------------------------------

-- A staff membership assigned to teach a class-subject. The composite keys tie the membership,
-- the class-subject and the academic year to one school. Ended, never deleted.
CREATE TABLE teacher_assignments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id         uuid NOT NULL,
  academic_year_id  uuid NOT NULL,
  class_subject_id  uuid NOT NULL,
  membership_id     uuid NOT NULL,
  assigned_by       uuid REFERENCES users (id) ON DELETE RESTRICT,
  assigned_at       timestamptz NOT NULL DEFAULT now(),
  ended_at          timestamptz,
  ended_by          uuid REFERENCES users (id) ON DELETE RESTRICT,

  CONSTRAINT teacher_assignments_school_fk FOREIGN KEY (school_id) REFERENCES schools (id) ON DELETE RESTRICT,
  CONSTRAINT teacher_assignments_class_subject_same_school_year_fk
    FOREIGN KEY (class_subject_id, school_id, academic_year_id)
    REFERENCES class_subjects (id, school_id, academic_year_id) ON DELETE RESTRICT,
  -- Uses school_memberships_id_school_key from 0001: a teacher of school B cannot be assigned
  -- to a class of school A.
  CONSTRAINT teacher_assignments_membership_same_school_fk FOREIGN KEY (membership_id, school_id)
    REFERENCES school_memberships (id, school_id) ON DELETE RESTRICT,
  CONSTRAINT teacher_assignments_end_complete CHECK ((ended_at IS NULL) = (ended_by IS NULL)),
  CONSTRAINT teacher_assignments_end_after_start CHECK (ended_at IS NULL OR ended_at >= assigned_at)
);
CREATE UNIQUE INDEX teacher_assignments_one_active
  ON teacher_assignments (class_subject_id, membership_id) WHERE ended_at IS NULL;
CREATE INDEX teacher_assignments_membership_active_idx
  ON teacher_assignments (membership_id) WHERE ended_at IS NULL;
