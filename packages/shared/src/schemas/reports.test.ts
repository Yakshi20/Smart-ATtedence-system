import { ratio, SchoolSummaryQuerySchema, SectionReportQuerySchema, StudentReportQuerySchema } from './reports';

test('ratio never divides by zero and rounds to 4 places', () => {
  expect(ratio(0, 0)).toBeNull();
  expect(ratio(5, 0)).toBeNull();
  expect(ratio(0, 7)).toBe(0);
  expect(ratio(2, 3)).toBe(0.6667);
  expect(ratio(3, 3)).toBe(1);
});

describe.each([
  ['student', StudentReportQuerySchema],
  ['section', SectionReportQuerySchema],
  ['summary', SchoolSummaryQuerySchema],
])('%s report range', (_name, schema) => {
  test('keeps the ordered, ≤366-day range rule after extension', () => {
    expect(schema.safeParse({ from: '2026-07-10', to: '2026-07-01' }).success).toBe(false);
    expect(schema.safeParse({ from: '2026-01-01', to: '2027-06-01' }).success).toBe(false);
    expect(schema.safeParse({ from: '2026-07-01', to: '2026-07-01' }).success).toBe(true);
    expect(schema.safeParse({ from: '2026-02-30', to: '2026-03-01' }).success).toBe(false);
  });
});

test('section filters must be UUIDs and groupBy is a closed set', () => {
  expect(SectionReportQuerySchema.parse({ from: '2026-07-01', to: '2026-07-31' }).groupBy).toBe('section');
  expect(SectionReportQuerySchema.safeParse({ from: '2026-07-01', to: '2026-07-31', sectionId: 'A' }).success).toBe(false);
  expect(SectionReportQuerySchema.safeParse({ from: '2026-07-01', to: '2026-07-31', groupBy: 'student' }).success).toBe(false);
});
