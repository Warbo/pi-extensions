#!/usr/bin/env tsx
/**
 * Integration tests for custom 'read' tool.
 *
 * Spins up an Emacs daemon and tests the read functionality with real buffers.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildReadElisp,
  parseEmacsclientOutput,
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

function assertContains(haystack: string, needle: string, message?: string) {
  if (!haystack.includes(needle)) {
    throw new Error(
      `${message || "assertContains"}: expected to find "${needle}"`
    );
  }
}

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok - ${name}`);
    passed++;
  } catch (err) {
    console.log(`not ok - ${name}`);
    console.log(`  # ${err instanceof Error ? err.message : String(err)}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Emacs daemon lifecycle
// ---------------------------------------------------------------------------

const tempDir = mkdtempSync(join(tmpdir(), "emacs-read-test-"));
const socketName = join(tempDir, "socket");
const testFilesDir = join(tempDir, "files");
mkdirSync(testFilesDir, { recursive: true });

function emacsclient(elisp: string): string {
  const result = execFileSync("emacsclient", [
    "--socket-name", socketName,
    "--eval", elisp,
  ], {
    encoding: "utf-8",
    timeout: 10000,
    env: { ...process.env, HOME: tempDir },
  });
  return result;
}

function emacsclientParsed(elisp: string): any {
  return parseEmacsclientOutput(emacsclient(elisp));
}

function cleanupBuffers() {
  // Kill all non-default buffers and deactivate regions
  try {
    emacsclient(`(progn
      ;; Deactivate mark
      (deactivate-mark t)
      ;; Kill file-visiting buffers
      (mapc (lambda (buf)
              (when (and (buffer-live-p buf)
                        (buffer-file-name buf))
                (with-current-buffer buf
                  (set-buffer-modified-p nil))
                (kill-buffer buf)))
            (buffer-list))
      nil)`);
  } catch (err) {
    // Ignore errors in cleanup
  }
}

function startEmacs() {
  execFileSync("emacs", [
    "--daemon=" + socketName,
    "--no-window-system",
    "--eval", "(require 'json)",
  ], {
    encoding: "utf-8",
    timeout: 30000,
    env: { ...process.env, HOME: tempDir },
  });
}

function stopEmacs() {
  try {
    execFileSync("emacsclient", [
      "--socket-name", socketName,
      "--eval", "(kill-emacs)",
    ], {
      encoding: "utf-8",
      timeout: 5000,
      env: { ...process.env, HOME: tempDir },
    });
  } catch (err) {
    // Expected - Emacs exits
  }
}

function cleanup() {
  stopEmacs();
  rmSync(tempDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

process.on("exit", cleanup);
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});

console.log("# Starting Emacs daemon...");
startEmacs();
console.log("# Emacs daemon started");

// Create test files
const testFile = join(testFilesDir, "test.txt");
const testFileContent = "Line 1\nLine 2\nLine 3\nLine 4\nLine 5\n";
writeFileSync(testFile, testFileContent);

const pythonFile = join(testFilesDir, "test.py");
const pythonContent = 'def hello():\n    print("Hello, world!")\n    return True\n';
writeFileSync(pythonFile, pythonContent);

const largeFile = join(testFilesDir, "large.txt");
const largeContent = "x".repeat(100000);
writeFileSync(largeFile, largeContent);

// ---------------------------------------------------------------------------
// Read tool - file path tests
// ---------------------------------------------------------------------------

test("read - opens file with absolute path", () => {
  const elisp = buildReadElisp(testFile, { pos: 1, length: 100 });
  const result = emacsclientParsed(elisp);

  assertEqual(result.path, testFile);
  assertEqual(result.exists, true);
  assertContains(result.got.content, "Line 1");
});

test("read - opens file with relative path", () => {
  const relPath = `./files/test.txt`;
  process.chdir(tempDir);

  const elisp = buildReadElisp(relPath, { pos: 1, length: 100 });
  const result = emacsclientParsed(elisp);

  assertEqual(result.exists, true);
  assertContains(result.got.content, "Line 1");
});

test("read - detects non-existent file", () => {
  const nonExistent = join(testFilesDir, "nonexistent.txt");
  const elisp = buildReadElisp(nonExistent, { pos: 1, length: 100 });
  const result = emacsclientParsed(elisp);

  assertEqual(result.exists, false);
  assertEqual(result.new, true);
  assertEqual(result.got.content, "");
});

test("read - opens python file and detects mode", () => {
  const elisp = buildReadElisp(pythonFile, { pos: 1, length: 100 });
  const result = emacsclientParsed(elisp);

  assertContains(result.mode.toLowerCase(), "python");
  assertContains(result.got.content, "def hello");
});

// ---------------------------------------------------------------------------
// Read tool - buffer name tests
// ---------------------------------------------------------------------------

test("read - accesses scratch buffer by name", () => {
  const elisp = buildReadElisp("*scratch*", { length: 100 });
  const result = emacsclientParsed(elisp);

  assertEqual(result.name, "*scratch*");
  assertEqual(result.path, null);
  assertEqual(result.exists, null);
});

test("read - creates buffer for name without slash", () => {
  const elisp = buildReadElisp("newbuffer", { pos: 1, length: 100 });
  const result = emacsclientParsed(elisp);

  assertEqual(result.new, true);
});

test("read - existing buffer is not new", () => {
  // Open a buffer first
  emacsclient(`(find-file "${testFile}")`);

  const elisp = buildReadElisp(testFile, { length: 100 });
  const result = emacsclientParsed(elisp);

  assertEqual(result.new, false);
});

// ---------------------------------------------------------------------------
// Read tool - position navigation tests
// ---------------------------------------------------------------------------

test("read - navigates to specific position", () => {
  const elisp = buildReadElisp(testFile, { pos: 10, length: 10 });
  const result = emacsclientParsed(elisp);

  assertEqual(result.point.pos, 10);
  assertEqual(result.got.start.pos, 10);
});

test("read - navigates to specific line", () => {
  const elisp = buildReadElisp(testFile, { line: 3, length: 10 });
  const result = emacsclientParsed(elisp);

  assertEqual(result.point.line, 3);
  assertEqual(result.got.start.line, 3);
});

test("read - navigates to line and column", () => {
  const elisp = buildReadElisp(testFile, { line: 2, col: 5, length: 10 });
  const result = emacsclientParsed(elisp);

  assertEqual(result.point.line, 2);
  assertEqual(result.point.col, 5);
});

test("read - pos overrides line/col", () => {
  const elisp = buildReadElisp(testFile, { pos: 1, line: 5, col: 10, length: 10 });
  const result = emacsclientParsed(elisp);

  assertEqual(result.point.pos, 1);
  assertEqual(result.point.line, 1);
});

test("read - negative pos moves backward from current point", () => {
  // First open and position at line 3
  emacsclient(`(progn (find-file "${testFile}") (goto-line 3))`);

  // Now read with negative pos
  const elisp = buildReadElisp(testFile, { pos: -5, length: 10 });
  const result = emacsclientParsed(elisp);

  assert(result.point.line < 3, "Should move backward");
});

test("read - no position stays at current point", () => {
  // Position at line 4
  emacsclient(`(progn (find-file "${testFile}") (goto-line 4))`);

  // Read without specifying position
  const elisp = buildReadElisp(testFile, { length: 10 });
  const result = emacsclientParsed(elisp);

  assertEqual(result.point.line, 4);
});

// ---------------------------------------------------------------------------
// Read tool - content extraction tests
// ---------------------------------------------------------------------------

test("read - extracts specific length", () => {
  const elisp = buildReadElisp(testFile, { pos: 1, length: 10 });
  const result = emacsclientParsed(elisp);

  assertEqual(result.got.length, 10);
  assertEqual(result.got.content, "Line 1\nLin");
});

test("read - extracts specific number of lines", () => {
  const elisp = buildReadElisp(testFile, { pos: 1, lines: 2 });
  const result = emacsclientParsed(elisp);

  assertEqual(result.got.lines, 2);
  assertContains(result.got.content, "Line 1");
  assertContains(result.got.content, "Line 2");
});

test("read - respects maxLength", () => {
  const elisp = buildReadElisp(largeFile, { pos: 1 }, 1000);
  const result = emacsclientParsed(elisp);

  assert(result.got.length <= 1000, "Should not exceed maxLength");
  assertEqual(result.got.truncated, true);
});

test("read - truncated is true when more content available", () => {
  const elisp = buildReadElisp(largeFile, { pos: 1, length: 1000 });
  const result = emacsclientParsed(elisp);

  assertEqual(result.got.truncated, true);
});

test("read - truncated is false when reaching end of buffer", () => {
  const smallContent = "abc";
  const smallFile = join(testFilesDir, "small.txt");
  writeFileSync(smallFile, smallContent);

  const elisp = buildReadElisp(smallFile, { pos: 1, length: 1000 });
  const result = emacsclientParsed(elisp);

  assertEqual(result.got.content, smallContent);
  assertEqual(result.got.truncated, false);
});

test("read - got.end points to correct position", () => {
  const elisp = buildReadElisp(testFile, { pos: 1, length: 10 });
  const result = emacsclientParsed(elisp);

  assertEqual(result.got.end.pos, result.got.start.pos + result.got.length);
});

// ---------------------------------------------------------------------------
// Read tool - temp mode tests
// ---------------------------------------------------------------------------

test("read - temp mode restores point", () => {
  // Position at line 2
  emacsclient(`(progn (find-file "${testFile}") (goto-line 2))`);

  // Read from line 4 with temp mode
  const elisp = buildReadElisp(testFile, { line: 4, length: 10, temp: true });
  emacsclientParsed(elisp);

  // Check that point is back at line 2
  const currentLine = emacsclientParsed(
    `(with-current-buffer (find-buffer-visiting "${testFile}") (line-number-at-pos))`
  );
  assertEqual(currentLine, 2);
});

test("read - temp mode kills new buffer", () => {
  const newFile = join(testFilesDir, "temp-test.txt");

  // Read with temp mode
  const elisp = buildReadElisp(newFile, { pos: 1, length: 10, temp: true });
  const result = emacsclientParsed(elisp);

  assertEqual(result.new, true);
  assertEqual(result.dead, true);

  // Verify buffer is killed
  const bufferExists = emacsclientParsed(`(if (get-buffer "temp-test.txt") t :json-false)`);
  assertEqual(bufferExists, false);
});

test("read - temp mode does not kill existing buffer", () => {
  // Open buffer first
  emacsclient(`(find-file "${testFile}")`);

  // Read with temp mode
  const elisp = buildReadElisp(testFile, { pos: 1, length: 10, temp: true });
  const result = emacsclientParsed(elisp);

  assertEqual(result.new, false);
  assertEqual(result.dead, false);

  // Verify buffer still exists
  const bufferExists = emacsclientParsed(
    `(if (find-buffer-visiting "${testFile}") t :json-false)`
  );
  assertEqual(bufferExists, true);
});

// ---------------------------------------------------------------------------
// Read tool - metadata tests
// ---------------------------------------------------------------------------

test("read - reports buffer size correctly", () => {
  const elisp = buildReadElisp(testFile, { pos: 1, length: 10 });
  const result = emacsclientParsed(elisp);

  assertEqual(result.size, testFileContent.length);
});

test("read - reports line count correctly", () => {
  const elisp = buildReadElisp(testFile, { pos: 1, length: 10 });
  const result = emacsclientParsed(elisp);

  assertEqual(result.lines, 5);
});

test("read - detects changed buffer", () => {
  // Open and modify buffer
  emacsclient(`(progn (find-file "${testFile}") (insert "x") (set-buffer-modified-p t))`);

  const elisp = buildReadElisp(testFile, { length: 10 });
  const result = emacsclientParsed(elisp);

  assertEqual(result.changed, true);
});

test("read - detects unchanged buffer", () => {
  cleanupBuffers();

  const elisp = buildReadElisp(testFile, { pos: 1, length: 10 });
  const result = emacsclientParsed(elisp);

  assertEqual(result.changed, false);
});

test("read - reports correct major mode", () => {
  const elisp = buildReadElisp(pythonFile, { pos: 1, length: 10 });
  const result = emacsclientParsed(elisp);

  assertContains(result.mode.toLowerCase(), "python");
});

// ---------------------------------------------------------------------------
// Read tool - region tests
// ---------------------------------------------------------------------------

test("read - region is null when no active region", () => {
  cleanupBuffers();

  const elisp = buildReadElisp(testFile, { pos: 1, length: 10 });
  const result = emacsclientParsed(elisp);

  assertEqual(result.region, null);
});

test("read - captures active region", () => {
  // Set up an active region
  emacsclient(`(progn
    (find-file "${testFile}")
    (goto-char 1)
    (push-mark (point) t t)
    (forward-char 10))`);

  const elisp = buildReadElisp(testFile, { length: 10 });
  const result = emacsclientParsed(elisp);

  assert(result.region !== null, "Should have region");
  assertEqual(result.region.start.pos, 1);
  assertEqual(result.region.end.pos, 11);
});

test("read - region content matches expected text", () => {
  cleanupBuffers();

  // Set up region
  emacsclient(`(progn
    (find-file "${testFile}")
    (goto-char 1)
    (push-mark (point) t t)
    (forward-char 6))`);

  const elisp = buildReadElisp(testFile, { length: 10 });
  const result = emacsclientParsed(elisp);

  assertEqual(result.region.content, "Line 1");
});

test("read - region truncated when too large", () => {
  cleanupBuffers();

  // Set up large region
  emacsclient(`(progn
    (find-file "${largeFile}")
    (goto-char 1)
    (push-mark (point) t t)
    (goto-char (point-max)))`);

  // Don't specify pos - we want to preserve the region
  const elisp = buildReadElisp(largeFile, { length: 10 }, 1000);
  const result = emacsclientParsed(elisp);

  assert(result.region !== null, "Should have region");
  assert(result.region.truncated, "Region should be truncated");
  assert(result.region.content.length <= 1000, "Region content should respect maxLength");
});

// ---------------------------------------------------------------------------
// Read tool - process tests
// ---------------------------------------------------------------------------

test("read - process is null for regular file buffer", () => {
  cleanupBuffers();

  const elisp = buildReadElisp(testFile, { pos: 1, length: 10 });
  const result = emacsclientParsed(elisp);

  assertEqual(result.process, null);
});

test("read - detects buffer with process", () => {
  // Start a shell process
  emacsclient(`(shell)`);

  const elisp = buildReadElisp("*shell*", { length: 10 });
  const result = emacsclientParsed(elisp);

  assert(result.process !== null, "Should have process");
  assertContains(result.process.cmd.toLowerCase(), "sh");
});

// ---------------------------------------------------------------------------
// Read tool - TRAMP tests (theoretical - requires SSH setup)
// ---------------------------------------------------------------------------

test("read - tramp is null for local file", () => {
  cleanupBuffers();

  const elisp = buildReadElisp(testFile, { pos: 1, length: 10 });
  const result = emacsclientParsed(elisp);

  assertEqual(result.tramp, null);
});

// ---------------------------------------------------------------------------
// Read tool - edge cases
// ---------------------------------------------------------------------------

test("read - handles empty file", () => {
  const emptyFile = join(testFilesDir, "empty.txt");
  writeFileSync(emptyFile, "");

  const elisp = buildReadElisp(emptyFile, { pos: 1, length: 100 });
  const result = emacsclientParsed(elisp);

  assertEqual(result.size, 0);
  assertEqual(result.lines, 0);
  assertEqual(result.got.content, "");
  assertEqual(result.got.truncated, false);
});

test("read - handles unicode content", () => {
  const unicodeFile = join(testFilesDir, "unicode.txt");
  const unicodeContent = "Hello 世界 🚀";
  writeFileSync(unicodeFile, unicodeContent);

  const elisp = buildReadElisp(unicodeFile, { pos: 1, length: 100 });
  const result = emacsclientParsed(elisp);

  assertEqual(result.got.content, unicodeContent);
});

test("read - handles file with only newlines", () => {
  const newlineFile = join(testFilesDir, "newlines.txt");
  writeFileSync(newlineFile, "\n\n\n\n");

  const elisp = buildReadElisp(newlineFile, { pos: 1, length: 100 });
  const result = emacsclientParsed(elisp);

  assertEqual(result.got.content, "\n\n\n\n");
  assertEqual(result.lines, 4);
});

test("read - point object has all fields", () => {
  const elisp = buildReadElisp(testFile, { line: 2, col: 3, length: 10 });
  const result = emacsclientParsed(elisp);

  assert(typeof result.point.pos === "number", "point.pos should be number");
  assert(typeof result.point.line === "number", "point.line should be number");
  assert(typeof result.point.col === "number", "point.col should be number");
});

test("read - got object has all required fields", () => {
  const elisp = buildReadElisp(testFile, { pos: 1, length: 10 });
  const result = emacsclientParsed(elisp);

  assert(typeof result.got.content === "string", "got.content should be string");
  assert(typeof result.got.length === "number", "got.length should be number");
  assert(typeof result.got.lines === "number", "got.lines should be number");
  assert(typeof result.got.truncated === "boolean", "got.truncated should be boolean");
  assert(typeof result.got.start === "object", "got.start should be object");
  assert(typeof result.got.end === "object", "got.end should be object");
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n# ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
