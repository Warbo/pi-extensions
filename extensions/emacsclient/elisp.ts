/**
 * Pure functions for generating Emacs Lisp code and parsing emacsclient output.
 *
 * All functions here are side-effect free — they produce elisp strings or parse
 * result strings. The actual emacsclient invocation lives in emacsclient.ts.
 */

// ---------------------------------------------------------------------------
// Elisp string escaping
// ---------------------------------------------------------------------------

/**
 * Escape a string for embedding inside an Emacs Lisp double-quoted string.
 * Handles backslashes, double quotes, and newlines.
 */
export function escapeElispString(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");
}

// ---------------------------------------------------------------------------
// Elisp generators
// ---------------------------------------------------------------------------

/**
 * Build elisp that returns a JSON-encoded list of buffer metadata.
 */
export function buildListBuffersElisp(): string {
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
                (cons "filepath" (buffer-file-name))
                (cons "modified" (if (buffer-modified-p) t :json-false))
                (cons "majorMode" (symbol-name major-mode))
                (cons "size" (buffer-size))
                (cons "visible" (if (get-buffer-window buf t) t :json-false)))))))
      (buffer-list))))`;
}

/**
 * Build elisp that returns JSON-encoded buffer content and metadata.
 */
export function buildBufferContentsElisp(
  buffer?: string,
  startChar?: number,
  endChar?: number
): string {
  const bufExpr = buffer
    ? `(or (get-buffer "${escapeElispString(buffer)}")
         (find-buffer-visiting "${escapeElispString(buffer)}")
         (error "No buffer found for: ${escapeElispString(buffer)}"))`
    : "(current-buffer)";

  const regionExpr =
    startChar !== undefined && endChar !== undefined
      ? `(let ((start ${startChar}) (end ${endChar})))`
      : `(let ((start (if (use-region-p) (region-beginning) (point-min)))
              (end (if (use-region-p) (region-end) (point-max)))))`;

  // We build a single let* form for clarity
  return `(json-encode
  (with-current-buffer ${bufExpr}
    (let* ((start ${startChar !== undefined ? startChar : "(if (use-region-p) (region-beginning) (point-min))"})
           (end ${endChar !== undefined ? endChar : "(if (use-region-p) (region-end) (point-max))"})
           (content (buffer-substring-no-properties start end)))
      (list
        (cons "buffer" (buffer-name))
        (cons "filepath" (buffer-file-name))
        (cons "content" content)
        (cons "length" (buffer-size))
        (cons "lineCount" (count-lines (point-min) (point-max)))
        (cons "majorMode" (symbol-name major-mode))
        (cons "modified" (if (buffer-modified-p) t :json-false))
        (cons "point" (point))
        (cons "pointLine" (line-number-at-pos (point)))
        (cons "pointColumn" (current-column))))))`;
}

/**
 * Build elisp that runs a tree-sitter query against a buffer, optionally
 * executing an action expression for each match.
 *
 * The query string is a tree-sitter S-expression pattern with @captures.
 * The action is elisp evaluated per match, with captures bound as variables.
 * If no action is given, matched node text is returned.
 */
export function buildTsQueryElisp(
  buffer: string,
  query: string,
  lang?: string,
  action?: string
): string {
  const bufExpr = `(or (get-buffer "${escapeElispString(buffer)}")
       (find-buffer-visiting "${escapeElispString(buffer)}")
       (let ((buf (find-file-noselect "${escapeElispString(buffer)}")))
         (unless buf (error "Cannot open buffer for: ${escapeElispString(buffer)}"))
         buf))`;

  const langExpr = lang
    ? `(or (treesit-language-at (point-min)) '${lang})`
    : "(treesit-language-at (point-min))";

  // Default action: return the text of the first capture's node
  const actionExpr = action
    ? action
    : "(treesit-node-text node t)";

  // Count the number of @captures in the query to know how to group
  const captureCount = (query.match(/@\w+/g) || []).length;
  return `(json-encode
  (with-current-buffer ${bufExpr}
    (let* ((lang ${langExpr})
           (root (treesit-buffer-root-node lang))
           (query-compiled (treesit-query-compile lang "${escapeElispString(query)}"))
           (captures (treesit-query-capture root query-compiled))
           (results '())
           (capture-count ${captureCount}))
      ;; Group consecutive captures into matches
      ;; treesit-query-capture returns captures in order, with all captures
      ;; from a single match appearing consecutively
      (let ((i 0))
        (while (< i (length captures))
          ;; Collect capture-count captures for this match
          (let* ((match-captures (cl-subseq captures i (min (+ i capture-count) (length captures))))
                 ;; Extract capture names and nodes
                 (capture-names (mapcar (lambda (cap) (intern (symbol-name (car cap))))
                                       match-captures))
                 (capture-nodes (mapcar 'cdr match-captures))
                 ;; Build a lambda: (lambda (name body ...) (let ((node <first-param>)) <action>))
                 (lambda-body (list 'let (list (list 'node (car capture-names)))
                                   (car (read-from-string "${escapeElispString(actionExpr)}"))))
                 (lambda-form (list 'lambda capture-names lambda-body))
                 (result (condition-case err
                           (apply (eval lambda-form) capture-nodes)
                         (error (format "ERROR: %s" (error-message-string err))))))
            (push (if (stringp result) result (format "%S" result)) results)
            (setq i (+ i capture-count)))))
      (nreverse results)))))`;
}

/**
 * Build elisp for evaluating an arbitrary expression and returning the
 * JSON-encoded result.
 */
export function buildEvalElisp(expression: string): string {
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

// ---------------------------------------------------------------------------
// Result parsing
// ---------------------------------------------------------------------------

/**
 * Unescape an Emacs prin1-printed string (the content between outer quotes).
 *
 * Emacs prin1 escapes only two things inside strings:
 *   \  →  \\
 *   "  →  \"
 *
 * We reverse this with a single character-by-character pass so that
 * sequences like \\n (prin1-escaped backslash before 'n') correctly
 * become \n (the JSON escape for newline) rather than a literal newline.
 */
function unescapeElispString(s: string): string {
  let result = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && i + 1 < s.length) {
      result += s[i + 1];
      i++;
    } else {
      result += s[i];
    }
  }
  return result;
}

/**
 * Parse the output of `emacsclient --eval`, which prints an Emacs Lisp value.
 *
 * For our purposes, the result is always a JSON string (from json-encode),
 * which emacsclient prints as an elisp string literal: "\"...\"".
 * We need to strip the outer quotes and unescape the prin1 escaping,
 * then parse the resulting JSON.
 *
 * Escaping layers:
 *   1. json-encode produces a JSON string with standard JSON escapes
 *      (\n for newline, \\ for backslash, \" for quote, etc.)
 *   2. Emacs prin1 wraps in double quotes and escapes \ → \\ and " → \"
 *   3. We undo layer 2, then JSON.parse handles layer 1
 */
export function parseEmacsclientOutput(raw: string): unknown {
  const trimmed = raw.trim();

  // emacsclient wraps string results in double quotes
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    // Remove outer quotes and undo prin1 string escaping
    const inner = unescapeElispString(trimmed.slice(1, -1));
    return JSON.parse(inner);
  }

  // Non-string results (numbers, nil, t) — shouldn't happen with json-encode
  // but handle gracefully
  if (trimmed === "nil") return null;
  if (trimmed === "t") return true;
  if (trimmed === ":json-false") return false;
  if (trimmed === ":json-null") return null;
  const num = Number(trimmed);
  if (!isNaN(num) && isFinite(num)) return num;

  // Last resort: return raw string
  return trimmed;
}

/**
 * Parse an emacsclient error output. Emacs errors look like:
 *   *ERROR*: Some error message
 * or the process may exit non-zero with a message on stderr.
 */
export function parseEmacsclientError(stderr: string): string {
  const trimmed = stderr.trim();
  // Strip common prefixes
  const match = trimmed.match(/^\*?ERROR\*?:\s*(.*)/s);
  return match ? match[1].trim() : trimmed;
}
