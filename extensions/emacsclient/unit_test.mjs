#!/usr/bin/env node
/**
 * Unit tests for emacsclient extension — pure function tests.
 *
 * Tests elisp generation and result parsing without any Emacs or Pi interaction.
 */

// We import the compiled/transpiled module. Since Nix builds run through tsc,
// we'll use a dynamic import of the .ts file via jiti (same as pi does), or
// we inline the logic for testing. For unit tests we re-implement the pure
// functions to test them in isolation.

// ---------------------------------------------------------------------------
// Inline copies of the pure functions (to avoid needing a TS build step in
// unit tests — integration tests will test the real module via pi).
// ---------------------------------------------------------------------------

import fs from 'fs';

function escapeElispString(s) {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");
}

function buildListBuffersElisp() {
  return `(json-encode
  (cl-remove-if
    (lambda (b) (null b))
    (mapcar
      (lambda (buf)
        (let ((name (buffer-name buf)))
          (unless (string-prefix-p " " name)
            (with-current-buffer buf
              (list
                (cons "name" name)
                (cons "filepath" (or (buffer-file-name) :null))
                (cons "modified" (if (buffer-modified-p) t :json-false))
                (cons "majorMode" (symbol-name major-mode))
                (cons "size" (buffer-size))
                (cons "visible" (if (get-buffer-window buf t) t :json-false)))))))
      (buffer-list))))`;
}

function buildBufferContentsElisp(buffer, startChar, endChar) {
  const bufExpr = buffer
    ? `(or (get-buffer "${escapeElispString(buffer)}")
         (find-buffer-visiting "${escapeElispString(buffer)}")
         (error "No buffer found for: ${escapeElispString(buffer)}"))`
    : "(current-buffer)";

  return `(json-encode
  (with-current-buffer ${bufExpr}
    (let* ((start ${startChar !== undefined ? startChar : "(if (use-region-p) (region-beginning) (point-min))"})
           (end ${endChar !== undefined ? endChar : "(if (use-region-p) (region-end) (point-max))"})
           (content (buffer-substring-no-properties start end)))
      (list
        (cons "buffer" (buffer-name))
        (cons "filepath" (or (buffer-file-name) :null))
        (cons "content" content)
        (cons "length" (buffer-size))
        (cons "lineCount" (count-lines (point-min) (point-max)))
        (cons "majorMode" (symbol-name major-mode))
        (cons "modified" (if (buffer-modified-p) t :json-false))
        (cons "point" (point))
        (cons "pointLine" (line-number-at-pos (point)))
        (cons "pointColumn" (current-column))))))`;
}

function buildEvalElisp(expression) {
  return `(json-encode
  (let ((result (progn ${expression})))
    (cond
      ((stringp result) result)
      ((null result) :json-false)
      ((eq result t) t)
      ((numberp result) result)
      ((listp result) result)
      (t (format "%S" result)))))`;
}

function parseEmacsclientOutput(raw) {
  const trimmed = raw.trim();
  fs.writeSync(2, trimmed);
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    const inner = trimmed
      .slice(1, -1)
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
    // Don't replace \n since it needs to remain escaped for JSON
    return JSON.parse(inner);
  }
  if (trimmed === "nil") return null;
  if (trimmed === "t") return true;
  const num = Number(trimmed);
  if (!isNaN(num)) return num;
  return trimmed;
}

function parseEmacsclientError(stderr) {
  const trimmed = stderr.trim();
  const match = trimmed.match(/^\*?ERROR\*?:\s*(.*)/s);
  return match ? match[1].trim() : trimmed;
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) throw new Error(message || "Assertion failed");
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(
      `${message || "assertEqual"}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
  }
}

function assertDeepEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(
      `${message || "assertDeepEqual"}: expected ${e}, got ${a}`
    );
  }
}

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
    passed++;
  } catch (err) {
    console.log(`not ok - ${name}`);
    console.log(`  # ${err.message}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// escapeElispString tests
// ---------------------------------------------------------------------------

test("escapeElispString - plain string unchanged", () => {
  assertEqual(escapeElispString("hello"), "hello");
});

test("escapeElispString - escapes double quotes", () => {
  assertEqual(escapeElispString('say "hello"'), 'say \\"hello\\"');
});

test("escapeElispString - escapes backslashes", () => {
  assertEqual(escapeElispString("path\\to\\file"), "path\\\\to\\\\file");
});

test("escapeElispString - escapes newlines", () => {
  assertEqual(escapeElispString("line1\nline2"), "line1\\nline2");
});

test("escapeElispString - handles combined escapes", () => {
  const result = escapeElispString('a "b\nc\\d"');
  assertEqual(result, 'a \\"b\\nc\\\\d\\"');
});

test("escapeElispString - empty string", () => {
  assertEqual(escapeElispString(""), "");
});

// ---------------------------------------------------------------------------
// buildListBuffersElisp tests
// ---------------------------------------------------------------------------

test("buildListBuffersElisp - returns string", () => {
  const result = buildListBuffersElisp();
  assert(typeof result === "string", "Should return a string");
});

test("buildListBuffersElisp - contains json-encode", () => {
  const result = buildListBuffersElisp();
  assert(result.includes("json-encode"), "Should use json-encode");
});

test("buildListBuffersElisp - contains buffer-list", () => {
  const result = buildListBuffersElisp();
  assert(result.includes("buffer-list"), "Should iterate buffer-list");
});

test("buildListBuffersElisp - filters internal buffers", () => {
  const result = buildListBuffersElisp();
  assert(
    result.includes('string-prefix-p " "'),
    "Should filter buffers starting with space"
  );
});

test("buildListBuffersElisp - includes expected fields", () => {
  const result = buildListBuffersElisp();
  for (const field of [
    "name",
    "filepath",
    "modified",
    "majorMode",
    "size",
    "visible",
  ]) {
    assert(result.includes(`"${field}"`), `Should include field: ${field}`);
  }
});

// ---------------------------------------------------------------------------
// buildBufferContentsElisp tests
// ---------------------------------------------------------------------------

test("buildBufferContentsElisp - no args uses current-buffer", () => {
  const result = buildBufferContentsElisp();
  assert(result.includes("(current-buffer)"), "Should use current-buffer");
});

test("buildBufferContentsElisp - with buffer name", () => {
  const result = buildBufferContentsElisp("main.py");
  assert(result.includes('"main.py"'), "Should reference buffer name");
  assert(result.includes("get-buffer"), "Should try get-buffer");
  assert(
    result.includes("find-buffer-visiting"),
    "Should try find-buffer-visiting"
  );
});

test("buildBufferContentsElisp - escapes buffer name", () => {
  const result = buildBufferContentsElisp('file "special".txt');
  assert(
    result.includes('file \\"special\\".txt'),
    "Should escape quotes in buffer name"
  );
});

test("buildBufferContentsElisp - with region", () => {
  const result = buildBufferContentsElisp("buf", 10, 50);
  assert(result.includes("10"), "Should include start position");
  assert(result.includes("50"), "Should include end position");
});

test("buildBufferContentsElisp - without region uses defaults", () => {
  const result = buildBufferContentsElisp("buf");
  assert(result.includes("use-region-p"), "Should check for active region");
  assert(result.includes("point-min"), "Should fall back to point-min");
  assert(result.includes("point-max"), "Should fall back to point-max");
});

test("buildBufferContentsElisp - includes expected fields", () => {
  const result = buildBufferContentsElisp();
  for (const field of [
    "buffer",
    "filepath",
    "content",
    "length",
    "lineCount",
    "majorMode",
    "modified",
    "point",
    "pointLine",
    "pointColumn",
  ]) {
    assert(result.includes(`"${field}"`), `Should include field: ${field}`);
  }
});

// ---------------------------------------------------------------------------
// buildEvalElisp tests
// ---------------------------------------------------------------------------

test("buildEvalElisp - wraps expression", () => {
  const result = buildEvalElisp("(+ 1 2)");
  assert(result.includes("(+ 1 2)"), "Should contain the expression");
  assert(result.includes("json-encode"), "Should use json-encode");
});

test("buildEvalElisp - handles multi-expression", () => {
  const result = buildEvalElisp("(setq x 1) (+ x 2)");
  assert(result.includes("progn"), "Should wrap in progn");
});

// ---------------------------------------------------------------------------
// parseEmacsclientOutput tests
// ---------------------------------------------------------------------------

test("parseEmacsclientOutput - JSON array string", () => {
  // emacsclient prints: "[{\"name\":\"scratch\"}]"
  const raw = '"[{\\"name\\":\\"scratch\\"}]"';
  const result = parseEmacsclientOutput(raw);
  assertDeepEqual(result, [{ name: "scratch" }]);
});

test("parseEmacsclientOutput - JSON object string", () => {
  const raw = '"{\\"buffer\\":\\"main.py\\",\\"point\\":42}"';
  const result = parseEmacsclientOutput(raw);
  assertDeepEqual(result, { buffer: "main.py", point: 42 });
});

test("parseEmacsclientOutput - simple string result", () => {
  const raw = '"\\"hello world\\""';
  const result = parseEmacsclientOutput(raw);
  assertEqual(result, "hello world");
});

test("parseEmacsclientOutput - number result", () => {
  assertEqual(parseEmacsclientOutput("42"), 42);
});

test("parseEmacsclientOutput - nil result", () => {
  assertEqual(parseEmacsclientOutput("nil"), null);
});

test("parseEmacsclientOutput - t result", () => {
  assertEqual(parseEmacsclientOutput("t"), true);
});

test("parseEmacsclientOutput - trims whitespace", () => {
  const result = parseEmacsclientOutput('  "42"  \n');
  assertEqual(result, 42);
});

test("parseEmacsclientOutput - nested JSON with newlines", () => {
  // Emacs buffer has "line1<newline>line2". json-encode produces {"content":"line1\nline2"}.
  // Emacs prin1 escapes \ to \\, " to \", so stdout is: "{\"content\":\"line1\\nline2\"}"
  const raw = '"{\\"content\\":\\"line1\\nline2\\"}"';
  const result = parseEmacsclientOutput(raw);
  assertDeepEqual(result, { content: "line1\nline2" });
});

test("parseEmacsclientOutput - empty JSON array", () => {
  const raw = '"[]"';
  const result = parseEmacsclientOutput(raw);
  assertDeepEqual(result, []);
});

test("parseEmacsclientOutput - boolean fields in JSON", () => {
  const raw = '"{\\"modified\\":false,\\"visible\\":true}"';
  const result = parseEmacsclientOutput(raw);
  assertDeepEqual(result, { modified: false, visible: true });
});

test("parseEmacsclientOutput - null fields in JSON", () => {
  const raw = '"{\\"filepath\\":null}"';
  const result = parseEmacsclientOutput(raw);
  assertDeepEqual(result, { filepath: null });
});

// ---------------------------------------------------------------------------
// parseEmacsclientError tests
// ---------------------------------------------------------------------------

test("parseEmacsclientError - standard error format", () => {
  assertEqual(
    parseEmacsclientError("*ERROR*: Wrong type argument"),
    "Wrong type argument"
  );
});

test("parseEmacsclientError - without asterisks", () => {
  assertEqual(
    parseEmacsclientError("ERROR: Buffer not found"),
    "Buffer not found"
  );
});

test("parseEmacsclientError - plain message", () => {
  assertEqual(
    parseEmacsclientError("emacsclient: can't find socket"),
    "emacsclient: can't find socket"
  );
});

test("parseEmacsclientError - trims whitespace", () => {
  assertEqual(
    parseEmacsclientError("  *ERROR*: foo  \n"),
    "foo"
  );
});

test("parseEmacsclientError - multiline error", () => {
  const result = parseEmacsclientError("*ERROR*: line1\nline2\nline3");
  assert(result.includes("line1"), "Should include first line");
  assert(result.includes("line3"), "Should include last line");
});

// ---------------------------------------------------------------------------
// Elisp structural integrity tests
// ---------------------------------------------------------------------------

test("buildListBuffersElisp - balanced parentheses", () => {
  const elisp = buildListBuffersElisp();
  let depth = 0;
  for (const ch of elisp) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    assert(depth >= 0, "Parentheses went negative");
  }
  assertEqual(depth, 0, "Parentheses not balanced");
});

test("buildBufferContentsElisp - balanced parentheses (no args)", () => {
  const elisp = buildBufferContentsElisp();
  let depth = 0;
  for (const ch of elisp) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    assert(depth >= 0, "Parentheses went negative");
  }
  assertEqual(depth, 0, "Parentheses not balanced");
});

test("buildBufferContentsElisp - balanced parentheses (with args)", () => {
  const elisp = buildBufferContentsElisp("test.py", 1, 100);
  let depth = 0;
  for (const ch of elisp) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    assert(depth >= 0, "Parentheses went negative");
  }
  assertEqual(depth, 0, "Parentheses not balanced");
});

test("buildEvalElisp - balanced parentheses", () => {
  const elisp = buildEvalElisp("(message \"hello\")");
  let depth = 0;
  for (const ch of elisp) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    assert(depth >= 0, "Parentheses went negative");
  }
  assertEqual(depth, 0, "Parentheses not balanced");
});

// ---------------------------------------------------------------------------
// Round-trip and edge case tests
// ---------------------------------------------------------------------------

test("parseEmacsclientOutput - handles content with special chars", () => {
  // Simulates buffer content containing quotes, backslashes, newlines.
  // The expected JS value has actual newlines and a real backslash.
  const expected = { content: 'line1\n"quoted"\npath\\to' };
  const jsonStr = JSON.stringify(expected);
  // emacsclient prin1 escapes \ to \\ and " to \"
  const elispStr =
    '"' + jsonStr.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
  const result = parseEmacsclientOutput(elispStr);
  assertDeepEqual(result, expected);
});

test("escapeElispString - roundtrip through parse", () => {
  // If we escape a string for embedding in elisp, the elisp engine would
  // produce the original string. We simulate this by un-escaping.
  const original = 'hello "world"\nfoo\\bar';
  const escaped = escapeElispString(original);

  // Simulate what Emacs does when it reads the escaped string in a "" literal
  const recovered = escaped
    .replace(/\\"/g, '"')
    .replace(/\\n/g, "\n")
    .replace(/\\\\/g, "\\");
  assertEqual(recovered, original);
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n# ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
