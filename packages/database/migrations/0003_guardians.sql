-- Slice 3 — guardian linking and parent phone identity.
--
-- Decisions referenced (docs/decisions/00_ANALYSIS_AND_OPEN_DECISIONS.md):
--   D-06  one users row per human; a parent is one user however many schools their children attend
--   D-07  relationship_type lives on the link, not on the guardian
--   Q4    OTP delivery goes through a provider interface; no paid SMS vendor is chosen here
--
-- Model:
--   guardians            a school-owned contact record (name + phone), independent of students.
--                        One per (school, phone): siblings in a school share it. A parent with
--                        children in two schools has one record in each, so no school ever reads
--                        a name or phone another school entered.
--   student_guardians    the link. Grants access only when status = 'verified'. Composite keys
--                        make a link between a guardian of one school and a student of another
--                        unrepresentable.
--   guardian_link_claims a parent's request to be linked, stored whether or not it matches a
--                        real student so the response never reveals which students exist.
--   otp_challenges       one-time phone codes, stored only as an HMAC.
--
-- A parent account reaches a child through: session user → phone_otp identity (verified phone)
-- → guardians.phone → student_guardians (verified) → student. Every hop is re-read per request.
--
-- Deliberately absent: consent_records — purposes and lawful basis need the legal review in
-- 07 §3 first. Aadhaar, addresses, occupations and income are not collected.

------------------------------------------------------------------------------------------
-- Phone identities for parents
------------------------------------------------------------------------------------------

-- A phone_otp identity proves possession of a phone at login time and has no stored secret.
ALTER TABLE auth_identities DROP CONSTRAINT auth_identities_provider_valid;
ALTER TABLE auth_identities
  ADD CONSTRAINT auth_identities_provider_valid CHECK (provider IN ('staff_password', 'phone_otp'));

ALTER TABLE auth_identities ALTER COLUMN secret_hash DROP NOT NULL;
ALTER TABLE auth_identities DROP CONSTRAINT auth_identities_secret_is_argon2id;
-- Same name and intent as in 0001: a stored secret is always an argon2id hash, never plaintext.
ALTER TABLE auth_identities
  ADD CONSTRAINT auth_identities_secret_is_argon2id CHECK (secret_hash IS NULL OR secret_hash LIKE '$argon2id$%');
-- Passwords must have a hash; phone identities must not, and their subject is an E.164 mobile.
ALTER TABLE auth_identities
  ADD CONSTRAINT auth_identities_secret_matches_provider CHECK (
    (provider = 'staff_password' AND secret_hash IS NOT NULL)
    OR (provider = 'phone_otp' AND secret_hash IS NULL AND provider_subject ~ '^\+91[6-9][0-9]{9}$')
  );

------------------------------------------------------------------------------------------
-- One-time phone codes
------------------------------------------------------------------------------------------

CREATE TABLE otp_challenges (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone            text NOT NULL,
  purpose          text NOT NULL,
  -- HMAC-SHA256(server key, challenge id ‖ code). A 6-digit code has 10⁶ values, so a plain hash
  -- would fall to an offline search if this table leaked; the keyed MAC does not.
  code_hmac        bytea NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  attempts         smallint NOT NULL DEFAULT 0,
  max_attempts     smallint NOT NULL,
  consumed_at      timestamptz,
  invalidated_at   timestamptz,
  -- What actually happened to the message. 'dev_outbox' is not delivery to a phone.
  delivery_status  text NOT NULL DEFAULT 'pending',

  CONSTRAINT otp_challenges_phone_e164_in CHECK (phone ~ '^\+91[6-9][0-9]{9}$'),
  CONSTRAINT otp_challenges_purpose_valid CHECK (purpose IN ('guardian_login')),
  CONSTRAINT otp_challenges_hmac_is_sha256 CHECK (octet_length(code_hmac) = 32),
  CONSTRAINT otp_challenges_expiry_after_creation CHECK (expires_at > created_at),
  CONSTRAINT otp_challenges_attempts_bounded CHECK (attempts >= 0 AND max_attempts BETWEEN 1 AND 10 AND attempts <= max_attempts),
  CONSTRAINT otp_challenges_single_outcome CHECK (NOT (consumed_at IS NOT NULL AND invalidated_at IS NOT NULL)),
  CONSTRAINT otp_challenges_delivery_status_valid
    CHECK (delivery_status IN ('pending', 'sent', 'dev_outbox', 'failed'))
);
-- At most one usable code per phone and purpose: issuing a new code invalidates the previous one,
-- so an attacker cannot accumulate several live codes to raise their guessing odds.
CREATE UNIQUE INDEX otp_challenges_one_open_per_phone
  ON otp_challenges (phone, purpose) WHERE consumed_at IS NULL AND invalidated_at IS NULL;

------------------------------------------------------------------------------------------
-- Guardians
------------------------------------------------------------------------------------------

CREATE TABLE guardians (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id   uuid NOT NULL REFERENCES schools (id) ON DELETE RESTRICT,
  full_name   text NOT NULL,
  -- Required: the verified phone of the parent's login is what connects an account to this record.
  phone       text NOT NULL,
  created_by  uuid REFERENCES users (id) ON DELETE RESTRICT,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT guardians_full_name_present CHECK (btrim(full_name) <> '' AND char_length(full_name) <= 120),
  CONSTRAINT guardians_phone_e164_in CHECK (phone ~ '^\+91[6-9][0-9]{9}$'),
  CONSTRAINT guardians_school_phone_key UNIQUE (school_id, phone),
  CONSTRAINT guardians_id_school_key UNIQUE (id, school_id)
);
CREATE INDEX guardians_phone_idx ON guardians (phone);

CREATE TABLE student_guardians (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id          uuid NOT NULL,
  student_id         uuid NOT NULL,
  guardian_id        uuid NOT NULL,
  relationship_type  text NOT NULL,
  status             text NOT NULL DEFAULT 'pending',
  initiated_via      text NOT NULL,
  created_by         uuid REFERENCES users (id) ON DELETE RESTRICT,
  created_at         timestamptz NOT NULL DEFAULT now(),
  verified_by        uuid REFERENCES users (id) ON DELETE RESTRICT,
  verified_at        timestamptz,
  rejected_by        uuid REFERENCES users (id) ON DELETE RESTRICT,
  rejected_at        timestamptz,
  revoked_by         uuid REFERENCES users (id) ON DELETE RESTRICT,
  revoked_at         timestamptz,
  -- Required when rejecting or revoking. Kept on this access-controlled row, not in audit_logs.
  status_reason      text,

  CONSTRAINT student_guardians_school_fk FOREIGN KEY (school_id) REFERENCES schools (id) ON DELETE RESTRICT,
  CONSTRAINT student_guardians_student_same_school_fk FOREIGN KEY (student_id, school_id)
    REFERENCES students (id, school_id) ON DELETE RESTRICT,
  CONSTRAINT student_guardians_guardian_same_school_fk FOREIGN KEY (guardian_id, school_id)
    REFERENCES guardians (id, school_id) ON DELETE RESTRICT,
  CONSTRAINT student_guardians_relationship_valid CHECK (
    relationship_type IN ('mother', 'father', 'grandparent', 'sibling', 'relative', 'legal_guardian', 'other')
  ),
  CONSTRAINT student_guardians_status_valid CHECK (status IN ('pending', 'verified', 'rejected', 'revoked')),
  CONSTRAINT student_guardians_initiated_via_valid CHECK (initiated_via IN ('school', 'guardian_claim')),
  CONSTRAINT student_guardians_reason_length CHECK (status_reason IS NULL OR (btrim(status_reason) <> '' AND char_length(status_reason) <= 500)),
  -- Each status carries exactly the who/when of the steps that led to it.
  CONSTRAINT student_guardians_status_consistent CHECK (
    (status = 'pending'  AND verified_at IS NULL AND rejected_at IS NULL AND revoked_at IS NULL)
 OR (status = 'verified' AND verified_at IS NOT NULL AND verified_by IS NOT NULL AND rejected_at IS NULL AND revoked_at IS NULL)
 OR (status = 'rejected' AND rejected_at IS NOT NULL AND rejected_by IS NOT NULL AND verified_at IS NULL
                         AND revoked_at IS NULL AND status_reason IS NOT NULL)
 OR (status = 'revoked'  AND revoked_at IS NOT NULL AND revoked_by IS NOT NULL AND verified_at IS NOT NULL
                         AND rejected_at IS NULL AND status_reason IS NOT NULL)
  )
);
-- One live link per student and guardian. Rejected and revoked links are history; a new request
-- may follow them.
CREATE UNIQUE INDEX student_guardians_one_live
  ON student_guardians (student_id, guardian_id) WHERE status IN ('pending', 'verified');
CREATE INDEX student_guardians_guardian_verified_idx
  ON student_guardians (guardian_id) WHERE status = 'verified';
CREATE INDEX student_guardians_school_status_idx ON student_guardians (school_id, status, created_at);
CREATE INDEX student_guardians_student_idx ON student_guardians (student_id);

-- History protection: no deletes; identity of a link is permanent; status moves only
-- pending → verified | rejected, verified → revoked; rejected and revoked are final.
CREATE FUNCTION student_guardians_protect_history() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'guardian links are never deleted; revoke or reject instead'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.school_id IS DISTINCT FROM OLD.school_id
     OR NEW.student_id IS DISTINCT FROM OLD.student_id
     OR NEW.guardian_id IS DISTINCT FROM OLD.guardian_id
     OR NEW.relationship_type IS DISTINCT FROM OLD.relationship_type
     OR NEW.initiated_via IS DISTINCT FROM OLD.initiated_via
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR (OLD.verified_at IS NOT NULL AND (NEW.verified_at IS DISTINCT FROM OLD.verified_at
                                          OR NEW.verified_by IS DISTINCT FROM OLD.verified_by))
  THEN
    RAISE EXCEPTION 'guardian link identity and history are immutable'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'pending'  AND NEW.status IN ('verified', 'rejected'))
    OR (OLD.status = 'verified' AND NEW.status = 'revoked')
  ) THEN
    RAISE EXCEPTION 'guardian link cannot move from % to %', OLD.status, NEW.status
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF OLD.status IN ('rejected', 'revoked') THEN
    RAISE EXCEPTION 'a % guardian link is final', OLD.status
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER student_guardians_history_immutable
  BEFORE UPDATE OR DELETE ON student_guardians
  FOR EACH ROW EXECUTE FUNCTION student_guardians_protect_history();

------------------------------------------------------------------------------------------
-- Parent-initiated link requests
------------------------------------------------------------------------------------------

-- Stored verbatim whether or not the school code and student number match anything, so the
-- parent-facing response and listing are identical for real and non-existent students. A match
-- creates a pending link for school review; it never verifies anything by itself.
CREATE TABLE guardian_link_claims (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claimant_user_id   uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  claimant_phone     text NOT NULL,
  school_code        text NOT NULL,
  student_number     text NOT NULL,
  relationship_type  text NOT NULL,
  claimant_name      text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  -- Set only when the claim matched a student in an active school.
  school_id          uuid REFERENCES schools (id) ON DELETE RESTRICT,
  link_id            uuid REFERENCES student_guardians (id) ON DELETE RESTRICT,

  CONSTRAINT glc_phone_e164_in CHECK (claimant_phone ~ '^\+91[6-9][0-9]{9}$'),
  CONSTRAINT glc_school_code_shape CHECK (char_length(school_code) BETWEEN 1 AND 16),
  CONSTRAINT glc_student_number_shape CHECK (char_length(student_number) BETWEEN 1 AND 32),
  CONSTRAINT glc_relationship_valid CHECK (
    relationship_type IN ('mother', 'father', 'grandparent', 'sibling', 'relative', 'legal_guardian', 'other')
  ),
  CONSTRAINT glc_claimant_name_present CHECK (btrim(claimant_name) <> '' AND char_length(claimant_name) <= 120),
  CONSTRAINT glc_match_consistent CHECK (link_id IS NULL OR school_id IS NOT NULL)
);
CREATE INDEX guardian_link_claims_claimant_idx ON guardian_link_claims (claimant_user_id, created_at);
