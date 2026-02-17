#!/usr/bin/env tsx
/**
 * Tests for custom 'read' tool in emacsclient extension.
 */

import {
  escapeElispString,
  parseEmacsclientOutput,
  buildReadElisp,
} from "./elisp.ts";

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(condition: boolean, message?: string): asserts condition {
  if (!condition) throw new Error(message || "Assertion failed");
}

function assertEqual<T>(actual: T, expected: T, message?: string) {
  if (actual !== expected) {
    throw new Error(
      `${message || "assertEqual"}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
  }
}

function assertDeepEqual<T>(actual: T, expected: T, message?: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(
      `${message || "assertDeepEqual"}: expected ${e}, got ${a}`
    );
  }
}

function assertContains(haystack: string, needle: string, message?: string) {
  if (!haystack.includes(needle)) {
    throw new Error(
      `${message || "assertContains"}: expected to find "${needle}" in string`
    );
  }
}

function test(name: string, fn: () => void | Promise<void>) {
  const runner = async () => {
    try {
      await fn();
      console.log(`ok - ${name}`);
      passed++;
    } catch (err) {
      console.log(`not ok - ${name}`);
      console.log(`  # ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }
  };
  return runner();
}

// ---------------------------------------------------------------------------
// buildReadElisp - basic parameter handling
// ---------------------------------------------------------------------------

test("buildReadElisp - accepts name parameter", () => {
  const result = buildReadElisp("test.txt");
  assert(typeof result === "string", "Should return a string");
  assertContains(result, "test.txt", "Should reference the name");
});

test("buildReadElisp - escapes special characters in name", () => {
  const result = buildReadElisp('file "with" quotes.txt');
  assertContains(result, '\\"', "Should escape quotes");
});

test("buildReadElisp - handles file path with forward slash", () => {
  const result = buildReadElisp("/home/user/file.txt");
  assertContains(result, "/home/user/file.txt", "Should include path");
  assertContains(result, "find-file", "Should use find-file for paths");
});

test("buildReadElisp - handles buffer name without slash", () => {
  const result = buildReadElisp("*scratch*");
  assertContains(result, "get-buffer", "Should use get-buffer for buffer names");
});

test("buildReadElisp - handles relative path starting with ./", () => {
  const result = buildReadElisp("./relative.txt");
  assertContains(result, "./relative.txt", "Should preserve relative path");
  assertContains(result, "find-file", "Should use find-file for paths");
});

test("buildReadElisp - detects TRAMP path", () => {
  const result = buildReadElisp("/ssh:user@host:/path/to/file");
  assertContains(result, "/ssh:user@host:/path/to/file", "Should handle TRAMP path");
  assertContains(result, "find-file", "Should use find-file for TRAMP");
});

// ---------------------------------------------------------------------------
// buildReadElisp - position parameters
// ---------------------------------------------------------------------------

test("buildReadElisp - accepts pos parameter", () => {
  const result = buildReadElisp("test.txt", { pos: 100 });
  assertContains(result, "100", "Should include position");
  assertContains(result, "goto-char", "Should use goto-char for position");
});

test("buildReadElisp - accepts line parameter", () => {
  const result = buildReadElisp("test.txt", { line: 10 });
  assertContains(result, "10", "Should include line number");
  assertContains(result, "goto-line", "Should use goto-line or forward-line");
});

test("buildReadElisp - accepts line and col parameters", () => {
  const result = buildReadElisp("test.txt", { line: 10, col: 5 });
  assertContains(result, "10", "Should include line number");
  assertContains(result, "5", "Should include column number");
});

test("buildReadElisp - pos overrides line/col", () => {
  const result = buildReadElisp("test.txt", { pos: 100, line: 10, col: 5 });
  assertContains(result, "100", "Should include position");
  assertContains(result, "goto-char", "Should prefer goto-char when pos is given");
});

test("buildReadElisp - handles negative pos", () => {
  const result = buildReadElisp("test.txt", { pos: -50 });
  assertContains(result, "-50", "Should include negative position");
});

test("buildReadElisp - handles negative line", () => {
  const result = buildReadElisp("test.txt", { line: -5 });
  assertContains(result, "-5", "Should include negative line number");
});

test("buildReadElisp - no position means stay at current point", () => {
  const result = buildReadElisp("test.txt");
  // Should not move point if no position specified
  // Note: goto-char inside save-excursion is fine as it's temporary
  assert(!result.includes("goto-char") || result.includes("save-excursion") || result.includes("unless"),
    "Should not unconditionally move point");
});

// ---------------------------------------------------------------------------
// buildReadElisp - content extraction parameters
// ---------------------------------------------------------------------------

test("buildReadElisp - accepts length parameter", () => {
  const result = buildReadElisp("test.txt", { length: 1000 });
  assertContains(result, "1000", "Should include length");
});

test("buildReadElisp - accepts lines parameter", () => {
  const result = buildReadElisp("test.txt", { lines: 10 });
  assertContains(result, "10", "Should include line count");
});

test("buildReadElisp - uses maxLength when no length/lines specified", () => {
  const result = buildReadElisp("test.txt", {}, 50000);
  assertContains(result, "50000", "Should use max length");
});

test("buildReadElisp - respects maxLength as upper bound", () => {
  const result = buildReadElisp("test.txt", { length: 100000 }, 50000);
  // Should cap at maxLength
  assertContains(result, "50000", "Should respect max length");
});

// ---------------------------------------------------------------------------
// buildReadElisp - temp mode
// ---------------------------------------------------------------------------

test("buildReadElisp - temp true saves and restores state", () => {
  const result = buildReadElisp("test.txt", { temp: true });
  assertContains(result, "save-excursion", "Should use save-excursion or save-current-buffer");
});

test("buildReadElisp - temp true kills new buffers", () => {
  const result = buildReadElisp("test.txt", { temp: true });
  assertContains(result, "kill-buffer", "Should kill buffer if newly opened");
});

test("buildReadElisp - temp false is default", () => {
  const resultExplicit = buildReadElisp("test.txt", { temp: false });
  const resultDefault = buildReadElisp("test.txt");
  // Both should not include buffer killing logic in the same way
  assertEqual(
    resultExplicit.includes("kill-buffer"),
    resultDefault.includes("kill-buffer"),
    "Default should match temp: false"
  );
});

// ---------------------------------------------------------------------------
// buildReadElisp - elisp structure
// ---------------------------------------------------------------------------

test("buildReadElisp - returns valid elisp", () => {
  const result = buildReadElisp("test.txt");
  assert(result.startsWith("("), "Should start with opening paren");
  assert(result.endsWith(")"), "Should end with closing paren");
});

test("buildReadElisp - balanced parentheses", () => {
  const result = buildReadElisp("test.txt", { pos: 1, length: 1000, temp: true });
  let depth = 0;
  for (const ch of result) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    assert(depth >= 0, "Parentheses went negative");
  }
  assertEqual(depth, 0, "Parentheses not balanced");
});

test("buildReadElisp - uses json-encode", () => {
  const result = buildReadElisp("test.txt");
  assertContains(result, "json-encode", "Should use json-encode for output");
});

test("buildReadElisp - includes all required fields", () => {
  const result = buildReadElisp("test.txt");
  const requiredFields = [
    "name", "path", "exists", "changed", "size", "lines", "mode",
    "eglot", "ts", "tramp", "new", "dead", "process", "point", "region", "got"
  ];

  for (const field of requiredFields) {
    assertContains(result, `"${field}"`, `Should include field: ${field}`);
  }
});

// ---------------------------------------------------------------------------
// Result parsing - basic structure
// ---------------------------------------------------------------------------

test("parseReadResult - handles complete result object", () => {
  const jsonResult = {
    name: "test.txt",
    path: "/home/user/test.txt",
    exists: true,
    changed: false,
    size: 1234,
    lines: 56,
    mode: "text-mode",
    eglot: false,
    ts: false,
    tramp: null,
    new: false,
    dead: false,
    process: null,
    point: { pos: 1, line: 1, col: 0 },
    region: null,
    got: {
      content: "test content",
      length: 12,
      lines: 1,
      start: { pos: 1, line: 1, col: 0 },
      end: { pos: 13, line: 1, col: 12 },
      truncated: false
    }
  };

  const elispStr = '"' + JSON.stringify(jsonResult).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  const parsed = parseEmacsclientOutput(elispStr);

  assertDeepEqual(parsed, jsonResult);
});

test("parseReadResult - handles file that doesn't exist", () => {
  const jsonResult = {
    name: "new.txt",
    path: "/home/user/new.txt",
    exists: false,
    changed: false,
    size: 0,
    lines: 0,
    mode: "fundamental-mode",
    eglot: false,
    ts: false,
    tramp: null,
    new: true,
    dead: false,
    process: null,
    point: { pos: 1, line: 1, col: 0 },
    region: null,
    got: {
      content: "",
      length: 0,
      lines: 0,
      start: { pos: 1, line: 1, col: 0 },
      end: { pos: 1, line: 1, col: 0 },
      truncated: false
    }
  };

  const elispStr = '"' + JSON.stringify(jsonResult).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  const parsed = parseEmacsclientOutput(elispStr);

  assertEqual(parsed.exists, false);
  assertEqual(parsed.new, true);
});

test("parseReadResult - handles buffer without file", () => {
  const jsonResult = {
    name: "*scratch*",
    path: null,
    exists: null,
    changed: false,
    size: 100,
    lines: 5,
    mode: "lisp-interaction-mode",
    eglot: false,
    ts: false,
    tramp: null,
    new: false,
    dead: false,
    process: null,
    point: { pos: 50, line: 3, col: 10 },
    region: null,
    got: {
      content: "test",
      length: 4,
      lines: 1,
      start: { pos: 50, line: 3, col: 10 },
      end: { pos: 54, line: 3, col: 14 },
      truncated: true
    }
  };

  const elispStr = '"' + JSON.stringify(jsonResult).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  const parsed = parseEmacsclientOutput(elispStr);

  assertEqual(parsed.path, null);
  assertEqual(parsed.exists, null);
});

test("parseReadResult - handles buffer with active region", () => {
  const jsonResult = {
    name: "test.py",
    path: "/home/user/test.py",
    exists: true,
    changed: true,
    size: 500,
    lines: 20,
    mode: "python-mode",
    eglot: true,
    ts: true,
    tramp: null,
    new: false,
    dead: false,
    process: null,
    point: { pos: 150, line: 8, col: 5 },
    region: {
      content: "selected text",
      truncated: false,
      start: { pos: 100, line: 5, col: 0 },
      end: { pos: 150, line: 8, col: 5 }
    },
    got: {
      content: "buffer content",
      length: 14,
      lines: 1,
      start: { pos: 150, line: 8, col: 5 },
      end: { pos: 164, line: 8, col: 19 },
      truncated: false
    }
  };

  const elispStr = '"' + JSON.stringify(jsonResult).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  const parsed = parseEmacsclientOutput(elispStr);

  assert(parsed.region !== null, "Should have region");
  assertEqual(parsed.region.content, "selected text");
});

test("parseReadResult - handles buffer with process", () => {
  const jsonResult = {
    name: "*shell*",
    path: null,
    exists: null,
    changed: false,
    size: 1000,
    lines: 30,
    mode: "shell-mode",
    eglot: false,
    ts: false,
    tramp: null,
    new: false,
    dead: false,
    process: {
      state: "run",
      cmd: "/bin/bash"
    },
    point: { pos: 1000, line: 30, col: 0 },
    region: null,
    got: {
      content: "$ ",
      length: 2,
      lines: 1,
      start: { pos: 1000, line: 30, col: 0 },
      end: { pos: 1002, line: 30, col: 2 },
      truncated: false
    }
  };

  const elispStr = '"' + JSON.stringify(jsonResult).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  const parsed = parseEmacsclientOutput(elispStr);

  assert(parsed.process !== null, "Should have process");
  assertEqual(parsed.process.state, "run");
  assertEqual(parsed.process.cmd, "/bin/bash");
});

test("parseReadResult - handles TRAMP remote buffer", () => {
  const jsonResult = {
    name: "remote.txt",
    path: "/ssh:user@host:/path/remote.txt",
    exists: true,
    changed: false,
    size: 200,
    lines: 10,
    mode: "text-mode",
    eglot: false,
    ts: false,
    tramp: "ssh:user@host",
    new: false,
    dead: false,
    process: null,
    point: { pos: 1, line: 1, col: 0 },
    region: null,
    got: {
      content: "remote content",
      length: 14,
      lines: 1,
      start: { pos: 1, line: 1, col: 0 },
      end: { pos: 15, line: 1, col: 14 },
      truncated: false
    }
  };

  const elispStr = '"' + JSON.stringify(jsonResult).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  const parsed = parseEmacsclientOutput(elispStr);

  assertEqual(parsed.tramp, "ssh:user@host");
  assertContains(parsed.path, "/ssh:user@host:");
});

test("parseReadResult - handles temp mode with new buffer", () => {
  const jsonResult = {
    name: "temp.txt",
    path: "/tmp/temp.txt",
    exists: false,
    changed: false,
    size: 0,
    lines: 0,
    mode: "fundamental-mode",
    eglot: false,
    ts: false,
    tramp: null,
    new: true,
    dead: true,
    process: null,
    point: { pos: 1, line: 1, col: 0 },
    region: null,
    got: {
      content: "",
      length: 0,
      lines: 0,
      start: { pos: 1, line: 1, col: 0 },
      end: { pos: 1, line: 1, col: 0 },
      truncated: false
    }
  };

  const elispStr = '"' + JSON.stringify(jsonResult).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  const parsed = parseEmacsclientOutput(elispStr);

  assertEqual(parsed.new, true);
  assertEqual(parsed.dead, true);
});

test("parseReadResult - handles truncated content", () => {
  const jsonResult = {
    name: "large.txt",
    path: "/home/user/large.txt",
    exists: true,
    changed: false,
    size: 100000,
    lines: 5000,
    mode: "text-mode",
    eglot: false,
    ts: false,
    tramp: null,
    new: false,
    dead: false,
    process: null,
    point: { pos: 1, line: 1, col: 0 },
    region: null,
    got: {
      content: "a".repeat(50000),
      length: 50000,
      lines: 1,
      start: { pos: 1, line: 1, col: 0 },
      end: { pos: 50001, line: 1, col: 50000 },
      truncated: true
    }
  };

  const elispStr = '"' + JSON.stringify(jsonResult).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  const parsed = parseEmacsclientOutput(elispStr);

  assertEqual(parsed.got.truncated, true);
  assertEqual(parsed.got.length, 50000);
});

test("parseReadResult - handles multiline content", () => {
  const content = "line1\nline2\nline3";
  const jsonResult = {
    name: "test.txt",
    path: "/home/user/test.txt",
    exists: true,
    changed: false,
    size: 17,
    lines: 3,
    mode: "text-mode",
    eglot: false,
    ts: false,
    tramp: null,
    new: false,
    dead: false,
    process: null,
    point: { pos: 1, line: 1, col: 0 },
    region: null,
    got: {
      content: content,
      length: 17,
      lines: 3,
      start: { pos: 1, line: 1, col: 0 },
      end: { pos: 18, line: 3, col: 5 },
      truncated: false
    }
  };

  const elispStr = '"' + JSON.stringify(jsonResult).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  const parsed = parseEmacsclientOutput(elispStr);

  assertEqual(parsed.got.content, content);
  assertEqual(parsed.got.lines, 3);
});

test("parseReadResult - handles region truncation", () => {
  const jsonResult = {
    name: "test.txt",
    path: "/home/user/test.txt",
    exists: true,
    changed: false,
    size: 1000,
    lines: 50,
    mode: "text-mode",
    eglot: false,
    ts: false,
    tramp: null,
    new: false,
    dead: false,
    process: null,
    point: { pos: 500, line: 25, col: 10 },
    region: {
      content: "a".repeat(60000),
      truncated: true,
      start: { pos: 100, line: 5, col: 0 },
      end: { pos: 900, line: 45, col: 10 }
    },
    got: {
      content: "test",
      length: 4,
      lines: 1,
      start: { pos: 500, line: 25, col: 10 },
      end: { pos: 504, line: 25, col: 14 },
      truncated: false
    }
  };

  const elispStr = '"' + JSON.stringify(jsonResult).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  const parsed = parseEmacsclientOutput(elispStr);

  assertEqual(parsed.region.truncated, true);
  assertEqual(parsed.region.content.length, 60000);
});

// ---------------------------------------------------------------------------
// Edge cases and error scenarios
// ---------------------------------------------------------------------------

test("buildReadElisp - handles very long file path", () => {
  const longPath = "/very/long/path/" + "a".repeat(500) + "/file.txt";
  const result = buildReadElisp(longPath);
  assertContains(result, "a".repeat(100), "Should handle long paths");
});

test("buildReadElisp - handles unicode in name", () => {
  const result = buildReadElisp("test_文件.txt");
  assertContains(result, "文件", "Should handle unicode");
});

test("buildReadElisp - handles emoji in name", () => {
  const result = buildReadElisp("test🚀.txt");
  assertContains(result, "🚀", "Should handle emoji");
});

test("buildReadElisp - handles backslashes in path", () => {
  const result = buildReadElisp("C:\\Users\\test\\file.txt");
  // Should escape properly for elisp
  assertContains(result, "\\\\", "Should escape backslashes");
});

test("buildReadElisp - handles zero pos", () => {
  const result = buildReadElisp("test.txt", { pos: 0 });
  assertContains(result, "0", "Should handle zero position");
});

test("buildReadElisp - handles zero length", () => {
  const result = buildReadElisp("test.txt", { length: 0 });
  assertContains(result, "0", "Should handle zero length");
});

test("buildReadElisp - handles zero lines", () => {
  const result = buildReadElisp("test.txt", { lines: 0 });
  assertContains(result, "0", "Should handle zero lines");
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

process.on("beforeExit", () => {
  console.log(`\n# ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
});
