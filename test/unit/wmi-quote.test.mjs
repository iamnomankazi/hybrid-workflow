import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { quoteWindowsArg, buildCommandLine } from '../../src/wmi.mjs';

const cases = [
  ['plain', 'abc', 'abc'],
  ['with space', 'a b', '"a b"'],
  ['embedded quote', 'a"b', '"a\\"b"'],
  ['trailing backslash, no space', 'C:\\dir\\', 'C:\\dir\\'],
  ['trailing backslash with space', 'C:\\my dir\\', '"C:\\my dir\\\\"'],
  ['backslash before quote', 'a\\"b', '"a\\\\\\"b"'],
  ['two backslashes before quote', 'a\\\\"b', '"a\\\\\\\\\\"b"'],
  ['interior backslashes untouched', 'a b\\c', '"a b\\c"'],
  ['empty', '', '""'],
  ['tab', 'a\tb', '"a\tb"'],
  ['newline', 'a\nb', '"a\nb"'],
  ['only a quote', '"', '"\\""'],
];

for (const [name, input, expected] of cases) {
  test(`quoteWindowsArg: ${name}`, () => {
    assert.equal(quoteWindowsArg(input), expected);
  });
}

test('quoteWindowsArg rejects non-strings', () => {
  assert.throws(() => quoteWindowsArg(5), TypeError);
});

test('buildCommandLine joins quoted exe and args', () => {
  assert.equal(
    buildCommandLine('C:\\Program Files\\nodejs\\node.exe', ['-e', 'a b', '']),
    '"C:\\Program Files\\nodejs\\node.exe" -e "a b" ""',
  );
});

test('round trip through a real Windows argv parser', () => {
  const args = ['plain', 'a b', 'a"b', 'C:\\my dir\\', 'a\\"b', 'a\\\\"b', '', 'a\tb', '"', 'x \\\\'];
  const script = 'console.log(JSON.stringify(process.argv.slice(1)))';
  // windowsVerbatimArguments makes Node use our quoting as-is, so the child's own argv
  // parser (the one WMI-launched children use) decodes exactly what we produced.
  const stdout = execFileSync(
    process.execPath,
    ['-e', quoteWindowsArg(script), ...args.map(quoteWindowsArg)],
    {
      windowsVerbatimArguments: true,
      windowsHide: true,
      encoding: 'utf8',
      argv0: quoteWindowsArg(process.execPath),
    },
  );
  assert.deepEqual(JSON.parse(stdout), args);
});
