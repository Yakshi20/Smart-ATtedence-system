import { csvCell, toCsv } from './csv';

test.each([
  ['=HYPERLINK("http://evil","x")', `"'=HYPERLINK(""http://evil"",""x"")"`],
  ['+1+1', "'+1+1"],
  ['-2+3', "'-2+3"],
  ['@SUM(A1)', "'@SUM(A1)"],
  ['\t=1', "'\t=1"],
  ['  =1', "'  =1"],
  ['\r=1', `"'\r=1"`],
])('neutralizes formula trigger %p', (input, expected) => {
  expect(csvCell(input)).toBe(expected);
});

test('quotes commas, quotes and newlines; leaves plain text and numbers alone', () => {
  expect(csvCell('A, B')).toBe('"A, B"');
  expect(csvCell('say "hi"')).toBe('"say ""hi"""');
  expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
  expect(csvCell('Kaveri')).toBe('Kaveri');
  expect(csvCell('ಕಾವೇರಿ')).toBe('ಕಾವೇರಿ');
  expect(csvCell(0.9524)).toBe('0.9524');
  expect(csvCell(null)).toBe('');
});

test('documents start with a BOM and use CRLF', () => {
  const out = toCsv(['a', 'b'], [[1, 'x']]);
  expect(out.startsWith('﻿')).toBe(true);
  expect(out).toBe('﻿a,b\r\n1,x\r\n');
});
