import {
  EmailSchema,
  IndianMobileSchema,
  LoginSchema,
  NewPasswordSchema,
  OpaqueTokenSchema,
  SchoolRegistrationRequestSchema,
  singleLineText,
} from './identity';

const validRegistration = {
  schoolName: '  Government   Higher Primary School,  Hebbal ',
  sector: 'government',
  districtName: 'Mysuru',
  addressLine: '1st Main Road',
  pincode: '570017',
  contactName: 'Lakshmi Devi',
  contactEmail: '  Head.Master@Example.IN ',
  contactPhone: '098450 12345',
};

describe('SchoolRegistrationRequestSchema', () => {
  test('normalizes whitespace, email and phone', () => {
    const out = SchoolRegistrationRequestSchema.parse(validRegistration);
    expect(out.schoolName).toBe('Government Higher Primary School, Hebbal');
    expect(out.contactEmail).toBe('head.master@example.in');
    expect(out.contactPhone).toBe('+919845012345');
  });

  test('strips fields that would try to self-approve or escalate', () => {
    const out = SchoolRegistrationRequestSchema.parse({
      ...validRegistration,
      status: 'approved',
      role: 'platform_admin',
      schoolId: '00000000-0000-4000-8000-000000000000',
    });
    expect(out).not.toHaveProperty('status');
    expect(out).not.toHaveProperty('role');
    expect(out).not.toHaveProperty('schoolId');
  });

  test.each([
    ['sector outside the enum', { sector: 'aided_or_whatever' }],
    ['malformed PIN code', { pincode: '056001' }],
    ['malformed UDISE', { udiseCode: '1234' }],
    ['blank school name', { schoolName: '    ' }],
    ['control characters', { schoolName: 'School\u0000Name' }],
    ['a number that cannot be an Indian mobile', { contactPhone: '5123456789' }],
    ['too few digits', { contactPhone: '98450' }],
    ['invalid email', { contactEmail: 'not-an-email' }],
  ])('rejects %s', (_label, patch) => {
    expect(SchoolRegistrationRequestSchema.safeParse({ ...validRegistration, ...patch }).success).toBe(
      false,
    );
  });
});

test('singleLineText enforces its bound after normalization', () => {
  expect(singleLineText(5).safeParse('  abc   de  ').success).toBe(false);
  expect(singleLineText(6).parse('  abc   de  ')).toBe('abc de');
});

test.each([
  ['9845012345', '+919845012345'],
  ['+91 98450-12345', '+919845012345'],
  ['919845012345', '+919845012345'],
])('IndianMobileSchema %s → %s', (input, expected) => {
  expect(IndianMobileSchema.parse(input)).toBe(expected);
});

test('EmailSchema lower-cases and trims', () => {
  expect(EmailSchema.parse(' A@B.CO ')).toBe('a@b.co');
});

describe('NewPasswordSchema', () => {
  test('requires at least 12 characters', () => {
    expect(NewPasswordSchema.safeParse('short-pass1').success).toBe(false);
    expect(NewPasswordSchema.safeParse('correct horse battery').success).toBe(true);
  });

  test('caps length so the server cannot be made to hash megabytes', () => {
    expect(NewPasswordSchema.safeParse('x'.repeat(129)).success).toBe(false);
  });

  test('applies NFKC so equivalent input hashes identically', () => {
    // U+FB01 (ﬁ ligature) is NFKC-equivalent to "fi".
    expect(NewPasswordSchema.parse('ﬁxed passphrase')).toBe('fixed passphrase');
  });
});

test('OpaqueTokenSchema accepts exactly 43 base64url characters', () => {
  expect(OpaqueTokenSchema.safeParse('A'.repeat(43)).success).toBe(true);
  expect(OpaqueTokenSchema.safeParse('A'.repeat(42)).success).toBe(false);
  expect(OpaqueTokenSchema.safeParse(`${'A'.repeat(42)}=`).success).toBe(false);
});

describe('LoginSchema', () => {
  test('requires a method discriminator', () => {
    expect(LoginSchema.safeParse({ email: 'a@b.co', password: 'x' }).success).toBe(false);
  });

  test('rejects a method not yet implemented', () => {
    expect(
      LoginSchema.safeParse({ method: 'phone_otp', phone: '9845012345', otp: '123456' }).success,
    ).toBe(false);
  });

  test('accepts staff_password', () => {
    expect(
      LoginSchema.parse({ method: 'staff_password', email: 'A@B.co', password: 'pw' }),
    ).toEqual({ method: 'staff_password', email: 'a@b.co', password: 'pw' });
  });
});
