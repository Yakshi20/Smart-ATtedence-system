-- Slice 1 — tenancy and identity.
--
-- Decisions referenced: docs/decisions/00_ANALYSIS_AND_OPEN_DECISIONS.md
--   D-09  refresh tokens stored only as SHA-256 hashes, with rotation lineage
--   D-18  public registration writes to a quarantined table; approval creates the school
--   Q2    only platform staff approve registrations
--
-- Deliberately absent (see docs/decisions/01_ARCHITECTURE_PROPOSAL.md §8):
--   districts / administrative_areas / admin_scope_memberships — no Slice 1 behaviour reads
--   them since Q2 removed district approval; the district is kept as submitted text.
--   permissions / role_permissions / membership_permission_grants — role defaults live in
--   the pure @smart-school/permissions registry; the grant overlay (D-02) is additive and
--   arrives with the first endpoint that writes a grant.
--
-- Rows here are never hard-deleted by the application, so foreign keys default to RESTRICT.

------------------------------------------------------------------------------------------
-- Identity
------------------------------------------------------------------------------------------

CREATE TABLE users (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Nullable: students (D-05) and phone-only parents will be users without an email.
  email               text,
  phone               text,
  display_name        text NOT NULL,
  status              text NOT NULL DEFAULT 'active',
  preferred_language  text NOT NULL DEFAULT 'en',
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT users_email_normalized CHECK (email IS NULL OR (email = lower(btrim(email)) AND email <> '')),
  CONSTRAINT users_phone_e164_in CHECK (phone IS NULL OR phone ~ '^\+91[6-9][0-9]{9}$'),
  CONSTRAINT users_display_name_present CHECK (btrim(display_name) <> ''),
  CONSTRAINT users_status_valid CHECK (status IN ('active', 'disabled')),
  CONSTRAINT users_language_valid CHECK (preferred_language IN ('en', 'kn'))
);
CREATE UNIQUE INDEX users_email_key ON users (email) WHERE email IS NOT NULL;

-- One row per way a user can prove who they are. Slice 1 has only staff email+password;
-- student and phone-OTP identities are added to the provider list by later migrations.
CREATE TABLE auth_identities (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  provider          text NOT NULL,
  provider_subject  text NOT NULL,
  secret_hash       text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT auth_identities_provider_valid CHECK (provider IN ('staff_password')),
  -- A last line of defence against a code path that stores a plaintext secret.
  CONSTRAINT auth_identities_secret_is_argon2id CHECK (secret_hash LIKE '$argon2id$%'),
  CONSTRAINT auth_identities_subject_unique UNIQUE (provider, provider_subject),
  CONSTRAINT auth_identities_one_per_provider UNIQUE (user_id, provider)
);

------------------------------------------------------------------------------------------
-- Tenancy
------------------------------------------------------------------------------------------

CREATE TABLE schools (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- An identifier, never a secret (non-negotiable 8). Random rather than sequential so the
  -- code does not disclose how many schools exist or when one joined.
  school_code    text NOT NULL,
  name           text NOT NULL,
  sector         text NOT NULL,
  udise_code     text,
  district_name  text NOT NULL,
  status         text NOT NULL DEFAULT 'active',
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT schools_school_code_key UNIQUE (school_code),
  CONSTRAINT schools_school_code_format CHECK (school_code ~ '^[A-HJKMNP-Z2-9]{8}$'),
  CONSTRAINT schools_udise_code_key UNIQUE (udise_code),
  CONSTRAINT schools_udise_code_format CHECK (udise_code IS NULL OR udise_code ~ '^[0-9]{11}$'),
  CONSTRAINT schools_sector_valid CHECK (sector IN ('government', 'private')),
  CONSTRAINT schools_status_valid CHECK (status IN ('pending', 'active', 'suspended', 'archived'))
);

-- Untrusted public input lives here, outside the tenant tables, until a platform reviewer
-- decides on it (D-18). Nothing in this table grants access to anything.
CREATE TABLE school_registration_requests (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_name    text NOT NULL,
  sector         text NOT NULL,
  udise_code     text,
  district_name  text NOT NULL,
  address_line   text NOT NULL,
  pincode        text NOT NULL,
  contact_name   text NOT NULL,
  contact_email  text NOT NULL,
  contact_phone  text NOT NULL,
  status         text NOT NULL DEFAULT 'pending',
  submitted_at   timestamptz NOT NULL DEFAULT now(),
  reviewed_by    uuid REFERENCES users (id) ON DELETE RESTRICT,
  reviewed_at    timestamptz,
  review_note    text,
  school_id      uuid REFERENCES schools (id) ON DELETE RESTRICT,

  CONSTRAINT srr_sector_valid CHECK (sector IN ('government', 'private')),
  CONSTRAINT srr_udise_code_format CHECK (udise_code IS NULL OR udise_code ~ '^[0-9]{11}$'),
  CONSTRAINT srr_pincode_format CHECK (pincode ~ '^[1-9][0-9]{5}$'),
  CONSTRAINT srr_contact_email_normalized CHECK (contact_email = lower(btrim(contact_email)) AND contact_email <> ''),
  CONSTRAINT srr_contact_phone_e164_in CHECK (contact_phone ~ '^\+91[6-9][0-9]{9}$'),
  CONSTRAINT srr_status_valid CHECK (status IN ('pending', 'approved', 'rejected')),
  CONSTRAINT srr_school_id_key UNIQUE (school_id),
  -- A decision is unrepresentable without a reviewer, and only an approval yields a school.
  CONSTRAINT srr_decision_consistent CHECK (
    (status = 'pending'  AND reviewed_by IS NULL     AND reviewed_at IS NULL     AND school_id IS NULL)
 OR (status = 'approved' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND school_id IS NOT NULL)
 OR (status = 'rejected' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND school_id IS NULL
                         AND review_note IS NOT NULL)
  )
);
CREATE INDEX srr_review_queue_idx ON school_registration_requests (status, submitted_at, id);

-- Platform roles are a separate table from school roles on purpose: nothing that resolves
-- school access reads this table, so a platform role cannot leak into a school scope.
CREATE TABLE platform_memberships (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  role        text NOT NULL,
  status      text NOT NULL DEFAULT 'active',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT platform_memberships_role_valid CHECK (role IN ('platform_admin')),
  CONSTRAINT platform_memberships_status_valid CHECK (status IN ('active', 'revoked')),
  CONSTRAINT platform_memberships_user_role_key UNIQUE (user_id, role)
);

CREATE TABLE school_memberships (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id   uuid NOT NULL REFERENCES schools (id) ON DELETE RESTRICT,
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  role        text NOT NULL,
  status      text NOT NULL DEFAULT 'active',
  created_by  uuid REFERENCES users (id) ON DELETE RESTRICT,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT school_memberships_role_valid CHECK (role IN ('school_admin', 'teacher')),
  CONSTRAINT school_memberships_status_valid CHECK (status IN ('active', 'revoked')),
  CONSTRAINT school_memberships_school_user_key UNIQUE (school_id, user_id),
  -- Target for composite foreign keys from school-owned tables in later slices.
  CONSTRAINT school_memberships_id_school_key UNIQUE (id, school_id)
);
CREATE INDEX school_memberships_user_idx ON school_memberships (user_id);

------------------------------------------------------------------------------------------
-- Sessions and one-time tokens
------------------------------------------------------------------------------------------

-- One row per login. The access token's `sid` claim names this row, and every request
-- re-reads it, so revoking a session takes effect on the very next request.
CREATE TABLE user_sessions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at     timestamptz NOT NULL DEFAULT now(),
  -- Absolute lifetime. Rotation does not extend it.
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz,
  revoke_reason  text,

  CONSTRAINT user_sessions_expiry_after_creation CHECK (expires_at > created_at),
  CONSTRAINT user_sessions_revoke_reason_valid
    CHECK (revoke_reason IN ('logout', 'refresh_token_reuse', 'administrative')),
  CONSTRAINT user_sessions_revocation_complete CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL))
);
CREATE INDEX user_sessions_active_by_user_idx ON user_sessions (user_id) WHERE revoked_at IS NULL;

-- The rotation lineage of a session's refresh tokens. Only the SHA-256 of each token is
-- stored: the token is 256 bits of randomness, so a fast hash is sufficient and a slow one
-- would only add latency.
CREATE TABLE refresh_tokens (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id       uuid NOT NULL REFERENCES user_sessions (id) ON DELETE CASCADE,
  parent_token_id  uuid REFERENCES refresh_tokens (id) ON DELETE CASCADE,
  token_hash       bytea NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  used_at          timestamptz,

  CONSTRAINT refresh_tokens_token_hash_key UNIQUE (token_hash),
  CONSTRAINT refresh_tokens_hash_is_sha256 CHECK (octet_length(token_hash) = 32),
  -- A token rotates into at most one successor, even if two refreshes race.
  CONSTRAINT refresh_tokens_single_successor UNIQUE (parent_token_id)
);
CREATE INDEX refresh_tokens_session_idx ON refresh_tokens (session_id);

-- Single-use tokens that let a newly provisioned staff member set their first password.
CREATE TABLE account_activation_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  token_hash  bytea NOT NULL,
  created_by  uuid REFERENCES users (id) ON DELETE RESTRICT,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,

  CONSTRAINT account_activation_tokens_token_hash_key UNIQUE (token_hash),
  CONSTRAINT account_activation_tokens_hash_is_sha256 CHECK (octet_length(token_hash) = 32)
);
CREATE INDEX account_activation_tokens_open_by_user_idx
  ON account_activation_tokens (user_id) WHERE used_at IS NULL;

------------------------------------------------------------------------------------------
-- Audit
------------------------------------------------------------------------------------------

CREATE TABLE audit_logs (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  actor_user_id  uuid REFERENCES users (id) ON DELETE RESTRICT,
  school_id      uuid REFERENCES schools (id) ON DELETE RESTRICT,
  action         text NOT NULL,
  entity_type    text NOT NULL,
  entity_id      text,
  request_id     text,
  metadata       jsonb NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT audit_logs_action_format CHECK (action ~ '^[a-z_]+(\.[a-z_]+)+$'),
  CONSTRAINT audit_logs_metadata_is_object CHECK (jsonb_typeof(metadata) = 'object')
);
CREATE INDEX audit_logs_school_time_idx ON audit_logs (school_id, occurred_at);
CREATE INDEX audit_logs_entity_idx ON audit_logs (entity_type, entity_id);

-- The audit trail is append-only. Enforced in the database so neither an application bug
-- nor an ad-hoc psql session can rewrite history without first dropping this trigger.
CREATE FUNCTION audit_logs_reject_mutation() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only (% rejected)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER audit_logs_append_only
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_reject_mutation();
