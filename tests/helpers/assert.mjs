// The whole assertion vocabulary. Two functions on purpose: a test that needs a
// third is usually a test that's checking two things.
//
//   t.eq(label, got, want)   deep-equals via JSON, prints `got` on failure
//   t.ok(label, cond, note)  a boolean claim, with optional context on the line
//   t.note(text)             prints context, asserts nothing
//
// Every line is printed as it runs so a hang tells you WHICH assertion hung.

export function makeAsserter(suiteName, results) {
  const record = (pass, label, detail) => {
    results.push({ suite: suiteName, label, pass });
    console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  };
  return {
    eq(label, got, want) {
      const pass = JSON.stringify(got) === JSON.stringify(want);
      record(pass, label, pass ? undefined : `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    },
    ok(label, cond, detail) {
      record(!!cond, label, detail);
    },
    note(text) {
      console.log(`        ${text}`);
    },
  };
}
