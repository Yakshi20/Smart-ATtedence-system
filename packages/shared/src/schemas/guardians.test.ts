import {
  CreateGuardianSchema,
  GuardianLinkClaimSchema,
  OtpRequestSchema,
  OtpVerifySchema,
  RelationshipTypeSchema,
} from './guardians';

test('guardian records keep only a name and a normalized mobile number', () => {
  expect(
    CreateGuardianSchema.parse({ fullName: ' Geetha  R ', phone: '98450 12345', aadhaar: '1234', address: 'x' }),
  ).toEqual({ fullName: 'Geetha R', phone: '+919845012345' });
});

test('OTP requests normalize the phone and default the purpose', () => {
  expect(OtpRequestSchema.parse({ phone: '+91 98450-12345' })).toEqual({
    phone: '+919845012345',
    purpose: 'guardian_login',
  });
  expect(OtpRequestSchema.safeParse({ phone: '12345' }).success).toBe(false);
  expect(OtpRequestSchema.safeParse({ phone: '9845012345', purpose: 'staff_reset' }).success).toBe(false);
});

test.each(['12345', '1234567', 'abcdef', '12 345'])('rejects code %p', (code) => {
  expect(OtpVerifySchema.safeParse({ phone: '9845012345', code }).success).toBe(false);
});

test('a link claim normalizes school code and student number', () => {
  expect(
    GuardianLinkClaimSchema.parse({
      schoolCode: ' abcd2345 ',
      studentNumber: ' adm/7 ',
      relationshipType: 'mother',
      guardianName: 'Geetha',
    }),
  ).toEqual({ schoolCode: 'ABCD2345', studentNumber: 'ADM/7', relationshipType: 'mother', guardianName: 'Geetha' });
});

test('a claim cannot carry a status or verification flag', () => {
  const out = GuardianLinkClaimSchema.parse({
    schoolCode: 'ABCD2345',
    studentNumber: '1',
    relationshipType: 'father',
    guardianName: 'R',
    status: 'verified',
    dateOfBirth: '2016-01-01',
  });
  expect(out).not.toHaveProperty('status');
  expect(out).not.toHaveProperty('dateOfBirth');
});

test('relationship types are a closed list', () => {
  expect(RelationshipTypeSchema.safeParse('neighbour').success).toBe(false);
});
