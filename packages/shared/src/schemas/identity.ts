import { z } from 'zod';

/**
 * Request schemas for Slice 1 (tenancy and identity).
 *
 * They live in the shared package so the web and mobile clients validate with exactly the
 * rules the API enforces. The API still validates every request itself — a client-side
 * check is a convenience, never a control.
 *
 * Normalization happens here, at the boundary, so every value that reaches a service or the
 * database is already canonical (trimmed, lower-cased email, E.164 phone). The database
 * CHECK constraints assert the same shapes as a second line of defence.
 */

// Excludes the whitespace controls (tab, newline, CR), which are collapsed to spaces first.
// Matching control characters is the purpose of this pattern, hence the lint exemption.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;

/**
 * Human-entered single-line text: NFC-normalized, whitespace collapsed, control
 * characters rejected. Bounded before normalization too, so a multi-megabyte string is
 * rejected without being processed.
 */
export function singleLineText(max: number) {
  return z
    .string()
    .max(max * 4)
    .refine((s) => !CONTROL_CHARACTERS.test(s), 'must not contain control characters')
    .transform((s) => s.normalize('NFC').replace(/\s+/g, ' ').trim())
    .pipe(z.string().min(1, 'must not be empty').max(max));
}

export const EmailSchema = z.string().max(320).trim().toLowerCase().pipe(z.email().max(254));

/** Indian mobile number in any common written form → `+91XXXXXXXXXX`. */
export const IndianMobileSchema = z
  .string()
  .max(32)
  .transform((s) => s.replace(/[\s\-().]/g, ''))
  .pipe(
    z
      .string()
      .regex(/^(?:\+?91|0)?[6-9]\d{9}$/, 'must be a valid Indian mobile number')
      .transform((s) => `+91${s.slice(-10)}`),
  );

/**
 * A password being set. NIST SP 800-63B: favour length over composition rules, and apply
 * NFKC so the same passphrase typed on different keyboards hashes identically. The upper
 * bound stops a caller making the server hash megabytes.
 */
export const NewPasswordSchema = z
  .string()
  .transform((s) => s.normalize('NFKC'))
  .pipe(z.string().min(12, 'must be at least 12 characters').max(128));

/** A password being presented. No policy check: only the same normalization and a bound. */
export const PresentedPasswordSchema = z
  .string()
  .max(512)
  .transform((s) => s.normalize('NFKC'))
  .pipe(z.string().min(1).max(128));

/** 32 random bytes, base64url without padding. Shape-checked before any database lookup. */
export const OpaqueTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'malformed token');

export const SchoolSectorSchema = z.enum(['government', 'private']);
export const SchoolStaffRoleSchema = z.enum(['school_admin', 'teacher']);

// ---------------------------------------------------------------------------------------
// School registration (public)
// ---------------------------------------------------------------------------------------

/**
 * Public registration payload. Unknown keys are stripped, so a caller cannot smuggle in
 * `status`, `role`, `schoolId` or anything else — there is no field here that could grant
 * access or pre-approve the request.
 */
export const SchoolRegistrationRequestSchema = z.object({
  schoolName: singleLineText(200),
  sector: SchoolSectorSchema,
  udiseCode: z
    .string()
    .trim()
    .regex(/^\d{11}$/, 'UDISE code must be 11 digits')
    .optional(),
  districtName: singleLineText(100),
  addressLine: singleLineText(300),
  pincode: z
    .string()
    .trim()
    .regex(/^[1-9]\d{5}$/, 'must be a 6-digit PIN code'),
  contactName: singleLineText(120),
  contactEmail: EmailSchema,
  contactPhone: IndianMobileSchema,
});
export type SchoolRegistrationRequestInput = z.infer<typeof SchoolRegistrationRequestSchema>;

// ---------------------------------------------------------------------------------------
// Platform review
// ---------------------------------------------------------------------------------------

export const ListRegistrationRequestsQuerySchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected']).default('pending'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

export const ApproveRegistrationSchema = z.object({
  note: singleLineText(1000).optional(),
});

export const RejectRegistrationSchema = z.object({
  reason: singleLineText(1000),
});

// ---------------------------------------------------------------------------------------
// Authentication (D-08: one endpoint, discriminated on `method`)
// ---------------------------------------------------------------------------------------

export const StaffPasswordLoginSchema = z.object({
  method: z.literal('staff_password'),
  email: EmailSchema,
  password: PresentedPasswordSchema,
});

/**
 * Further variants (`student_password`, `phone_otp`) join this union in later slices.
 * Each is validated strictly on its own shape rather than through one permissive schema.
 */
export const LoginSchema = z.discriminatedUnion('method', [StaffPasswordLoginSchema]);
export type LoginInput = z.infer<typeof LoginSchema>;

export const RefreshSchema = z.object({ refreshToken: OpaqueTokenSchema });

export const ActivateAccountSchema = z.object({
  token: OpaqueTokenSchema,
  password: NewPasswordSchema,
});

// ---------------------------------------------------------------------------------------
// School staff
// ---------------------------------------------------------------------------------------

export const InviteStaffSchema = z.object({
  email: EmailSchema,
  displayName: singleLineText(120),
  role: SchoolStaffRoleSchema,
});
export type InviteStaffInput = z.infer<typeof InviteStaffSchema>;
