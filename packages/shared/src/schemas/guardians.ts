import { z } from 'zod';
import { PaginationQuerySchema, StudentNumberSchema } from './academic';
import { IndianMobileSchema, singleLineText } from './identity';

/**
 * Request schemas for Slice 3 (guardian linking and parent phone identity).
 *
 * Data minimization (07 §4): a guardian is a name and a mobile number. No Aadhaar, address,
 * occupation, income or date of birth is accepted — unknown keys are stripped.
 */

/** Stored on the link, not the guardian (D-07): one person can be "mother" to one child and "legal guardian" to another. */
export const RelationshipTypeSchema = z.enum([
  'mother',
  'father',
  'grandparent',
  'sibling',
  'relative',
  'legal_guardian',
  'other',
]);
export type RelationshipType = z.infer<typeof RelationshipTypeSchema>;

// ---------------------------------------------------------------------------------------
// Phone OTP (public)
// ---------------------------------------------------------------------------------------

export const OtpPurposeSchema = z.literal('guardian_login').default('guardian_login');

export const OtpRequestSchema = z.object({
  phone: IndianMobileSchema,
  purpose: OtpPurposeSchema,
});

export const OtpVerifySchema = z.object({
  phone: IndianMobileSchema,
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'must be 6 digits'),
  purpose: OtpPurposeSchema,
});

// ---------------------------------------------------------------------------------------
// School staff: guardian records and links
// ---------------------------------------------------------------------------------------

export const CreateGuardianSchema = z.object({
  fullName: singleLineText(120),
  phone: IndianMobileSchema,
});

export const UpdateGuardianSchema = z
  .object({ fullName: singleLineText(120).optional(), phone: IndianMobileSchema.optional() })
  .refine((v) => v.fullName !== undefined || v.phone !== undefined, 'at least one field is required');

export const GuardianListQuerySchema = PaginationQuerySchema.extend({
  phone: IndianMobileSchema.optional(),
});

export const CreateGuardianLinkSchema = z.object({
  guardianId: z.uuid(),
  relationshipType: RelationshipTypeSchema,
});

export const GuardianLinkListQuerySchema = PaginationQuerySchema.extend({
  status: z.enum(['pending', 'verified', 'rejected', 'revoked']).default('pending'),
});

export const LinkDecisionReasonSchema = z.object({ reason: singleLineText(500) });

// ---------------------------------------------------------------------------------------
// Parent: link requests
// ---------------------------------------------------------------------------------------

/**
 * A parent's request to be linked to a child. Knowing a school code and student number is
 * **not** proof of guardianship: a request only ever produces a pending link that school staff
 * must verify. The response is identical whether or not the student exists.
 */
export const GuardianLinkClaimSchema = z.object({
  schoolCode: z
    .string()
    .trim()
    .toUpperCase()
    .pipe(z.string().regex(/^[A-Z0-9]{1,16}$/, 'malformed school code')),
  studentNumber: StudentNumberSchema,
  relationshipType: RelationshipTypeSchema,
  guardianName: singleLineText(120),
});
