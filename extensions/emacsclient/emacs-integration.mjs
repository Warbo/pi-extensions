#!/usr/bin/env node
/**
 * Emacs integration tests.
 *
 * Spins up an Emacs daemon with a known socket, sends our generated elisp
 * through emacsclient, and verifies the results.
 *
 * Requires: emacs, emacsclient on PATH (provided by Nix build environment).
 */

import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Inline pure functions (same as unit_test.mjs)
// ---------------------------------------------------------------------------

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
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    const inner = trimmed
      .slice(1, -1)
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\")
      .replace(/\\n/g, "\n");
    return JSON.parse(inner);
  }
  if (trimmed === "nil") return null;
  if (trimmed === "t") return true;
  const num = Number(trimmed);
  if (!isNaN(num)) return num;
  return trimmed;
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

async function test(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
    passed++;
  } catch (err) {
    console.log(`not ok - ${name}`);
    console.log(`  # ${err.message}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Emacs daemon lifecycle
// ---------------------------------------------------------------------------

const tempDir = mkdirSync(join(tmpdir(), `emacs-test-${Date.now()}`), {
  recursive: true,
});
const socketName = join(tempDir, "emacs-test-socket");

function emacsclient(elisp) {
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

function emacsclientParsed(elisp) {
  return parseEmacsclientOutput(emacsclient(elisp));
}

function startEmacs() {
  // Start Emacs daemon with minimal config
  execFileSync("emacs", [
    "--fg-daemon=" + socketName,
    "--quick",       // No init file
  ], {
    timeout: 15000,
    env: { ...process.env, HOME: tempDir },
    stdio: "pipe",
  });
}

function stopEmacs() {
  try {
    execFileSync("emacsclient", [
      "--socket-name", socketName,
      "--eval", "(kill-emacs)",
    ], {
      timeout: 5000,
      env: { ...process.env, HOME: tempDir },
      stdio: "pipe",
    });
  } catch {
    // Emacs may already be dead
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

(async function () {
  // Start the Emacs daemon
  console.log("# Starting Emacs daemon...");
  try {
    startEmacs();
  } catch (err) {
    console.log(`Bail out! Could not start Emacs daemon: ${err.message}`);
    rmSync(tempDir, { recursive: true, force: true });
    process.exit(1);
  }

  // Verify it's running
  try {
    const ver = emacsclient("(emacs-version)");
    console.log(`# Emacs running: ${ver.trim().slice(0, 60)}`);
  } catch (err) {
    console.log(`Bail out! Cannot connect to Emacs: ${err.message}`);
    rmSync(tempDir, { recursive: true, force: true });
    process.exit(1);
  }

  // -- Tests --

  await test("emacs_eval - simple arithmetic", () => {
    const elisp = buildEvalElisp("(+ 21 21)");
    const result = emacsclientParsed(elisp);
    assertEqual(result, 42);
  });

  await test("emacs_eval - string result", () => {
    const elisp = buildEvalElisp('(concat "hello" " " "world")');
    const result = emacsclientParsed(elisp);
    assertEqual(result, "hello world");
  });

  await test("emacs_eval - nil result", () => {
    const elisp = buildEvalElisp("nil");
    const result = emacsclientParsed(elisp);
    assertEqual(result, false);
  });

  await test("emacs_eval - t result", () => {
    const elisp = buildEvalElisp("t");
    const result = emacsclientParsed(elisp);
    assertEqual(result, true);
  });

  await test("emacs_eval - list result", () => {
    const elisp = buildEvalElisp("'(1 2 3)");
    const result = emacsclientParsed(elisp);
    assertDeepEqual(result, [1, 2, 3]);
  });

  await test("emacs_list_buffers - returns array", () => {
    const elisp = buildListBuffersElisp();
    const result = emacsclientParsed(elisp);
    assert(Array.isArray(result), "Should return an array");
    assert(result.length > 0, "Should have at least one buffer");
  });

  await test("emacs_list_buffers - buffer has expected fields", () => {
    const elisp = buildListBuffersElisp();
    const result = emacsclientParsed(elisp);
    const buf = result[0];
    assert("name" in buf, "Should have name");
    assert("majorMode" in buf, "Should have majorMode");
    assert("size" in buf, "Should have size");
    assert("modified" in buf, "Should have modified");
    assert("visible" in buf, "Should have visible");
    assert("filepath" in buf, "Should have filepath");
  });

  await test("emacs_list_buffers - excludes internal buffers", () => {
    const elisp = buildListBuffersElisp();
    const result = emacsclientParsed(elisp);
    for (const buf of result) {
      assert(
        !buf.name.startsWith(" "),
        `Internal buffer leaked: "${buf.name}"`
      );
    }
  });

  await test("emacs_list_buffers - scratch buffer present", () => {
    const elisp = buildListBuffersElisp();
    const result = emacsclientParsed(elisp);
    const scratch = result.find((b) => b.name === "*scratch*");
    assert(scratch, "Should have *scratch* buffer");
    assertEqual(scratch.filepath, null, "scratch has no file");
  });

  // Create a test file and open it in Emacs for buffer content tests
  const testFilePath = join(tempDir, "test-file.txt");
  writeFileSync(testFilePath, "line one\nline two\nline three\n", "utf-8");

  await test("setup - open test file in emacs", () => {
    emacsclient(`(find-file-noselect "${escapeElispString(testFilePath)}")`);
    // Verify it's open
    const elisp = buildListBuffersElisp();
    const bufs = emacsclientParsed(elisp);
    const found = bufs.find((b) => b.name === "test-file.txt");
    assert(found, "test-file.txt should be in buffer list");
  });

  await test("emacs_buffer_contents - by buffer name", () => {
    const elisp = buildBufferContentsElisp("test-file.txt");
    const result = emacsclientParsed(elisp);
    assertEqual(result.buffer, "test-file.txt");
    assertEqual(result.filepath, testFilePath);
    assert(
      result.content.includes("line one"),
      "Content should include file text"
    );
    assert(result.lineCount >= 3, "Should have at least 3 lines");
    assertEqual(result.modified, false);
    assert(typeof result.point === "number", "point should be a number");
    assert(typeof result.pointLine === "number", "pointLine should be a number");
    assert(typeof result.pointColumn === "number", "pointColumn should be a number");
  });

  await test("emacs_buffer_contents - by file path", () => {
    const elisp = buildBufferContentsElisp(testFilePath);
    const result = emacsclientParsed(elisp);
    assertEqual(result.buffer, "test-file.txt");
    assert(
      result.content.includes("line two"),
      "Content should include file text"
    );
  });

  await test("emacs_buffer_contents - with char range", () => {
    const elisp = buildBufferContentsElisp("test-file.txt", 1, 9);
    const result = emacsclientParsed(elisp);
    // Emacs positions are 1-indexed; chars 1-8 should be "line one"
    assertEqual(result.content, "line one");
  });

  await test("emacs_buffer_contents - nonexistent buffer errors", () => {
    const elisp = buildBufferContentsElisp("nonexistent-buffer-xyz");
    try {
      emacsclient(elisp);
      throw new Error("Should have thrown");
    } catch (err) {
      assert(
        err.message.includes("No buffer found") || err.status !== 0,
        "Should error for missing buffer"
      );
    }
  });

  // Test with modified buffer
  await test("emacs_buffer_contents - modified flag", () => {
    // Insert text to modify the buffer
    emacsclient(
      `(with-current-buffer "test-file.txt" (goto-char (point-max)) (insert "new line\\n"))`
    );
    const elisp = buildBufferContentsElisp("test-file.txt");
    const result = emacsclientParsed(elisp);
    assertEqual(result.modified, true);
    assert(
      result.content.includes("new line"),
      "Should contain inserted text"
    );
  });

  // Test eval with buffer context
  await test("emacs_eval - buffer-local query", () => {
    const elisp = buildEvalElisp(
      '(with-current-buffer "test-file.txt" (symbol-name major-mode))'
    );
    const result = emacsclientParsed(elisp);
    assert(typeof result === "string", "Should return mode name string");
    assert(result.length > 0, "Mode name should be non-empty");
  });

  // Cleanup
  stopEmacs();
  rmSync(tempDir, { recursive: true, force: true });

  console.log(`\n# ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
