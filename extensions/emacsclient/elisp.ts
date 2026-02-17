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

// ---------------------------------------------------------------------------
// Read tool elisp builder
// ---------------------------------------------------------------------------

/**
 * Build elisp for the custom 'read' tool.
 *
 * This generates a comprehensive elisp expression that:
 * - Opens/finds a buffer by path or name
 * - Optionally moves point
 * - Extracts a snippet of content
 * - Collects extensive metadata
 * - Optionally restores state (temp mode)
 */
export function buildReadElisp(
  name: string,
  options: {
    pos?: number;
    line?: number;
    col?: number;
    length?: number;
    lines?: number;
    temp?: boolean;
  } = {},
  maxLength: number = 51200
): string {
  const isPath = name.includes('/');
  const temp = options.temp ?? false;

  // Determine the effective length to read
  const requestedLength = options.length;
  const requestedLines = options.lines;
  const effectiveMaxLength = Math.min(maxLength, requestedLength ?? maxLength);

  // Build the elisp expression
  return `(json-encode
  (let* (;; Track whether buffer was newly opened
         (was-new nil)
         ;; Track original point (for temp mode)
         (original-point nil)
         ;; Determine if name is a path or buffer name
         (is-path ${isPath ? 't' : 'nil'})
         ;; Get or create the buffer
         (buf (if is-path
                  ;; Path: use find-file or find-buffer-visiting
                  (or (find-buffer-visiting "${escapeElispString(name)}")
                      (progn
                        (setq was-new t)
                        (find-file-noselect "${escapeElispString(name)}")))
                ;; Buffer name: get-buffer or create via find-file
                (or (get-buffer "${escapeElispString(name)}")
                    (progn
                      (setq was-new t)
                      (find-file-noselect "${escapeElispString(name)}"))))))
    (with-current-buffer buf
      ${temp ? '(setq original-point (point))' : ''}
      ;; Move point if requested
      ${options.pos !== undefined ? `
      (goto-char (if (< ${options.pos} 0)
                     (max (point-min) (+ (point) ${options.pos}))
                   ${options.pos}))` : ''}
      ${options.pos === undefined && options.line !== undefined ? `
      (let ((target-line ${options.line}))
        (if (< target-line 0)
            (forward-line target-line)
          ;; goto-line equivalent for programmatic use
          (progn
            (goto-char (point-min))
            (forward-line (1- target-line)))))
      ${options.col !== undefined ? `(move-to-column ${options.col})` : ''}` : ''}

      (let* (;; Calculate content boundaries
             (content-start (point))
             (content-end (save-excursion
                            ${requestedLines !== undefined ? `
                            (forward-line ${requestedLines})
                            (min (point) (+ content-start ${effectiveMaxLength}))` : `
                            (min (point-max) (+ content-start ${effectiveMaxLength}))`}))
             ;; Extract content
             (content (buffer-substring-no-properties content-start content-end))
             (content-length (length content))
             (content-line-count (with-temp-buffer
                                   (insert content)
                                   (count-lines (point-min) (point-max))))
             ;; Check if truncated: more content available beyond what we extracted
             (truncated (< content-end (point-max)))
             ;; Get region info if active
             (region-active (use-region-p))
             (region-content (when region-active
                              (buffer-substring-no-properties
                               (region-beginning)
                               (min (region-end) (+ (region-beginning) ${maxLength})))))
             (region-truncated (when region-active
                                (> (- (region-end) (region-beginning)) ${maxLength})))
             ;; Get process info
             (proc (get-buffer-process (current-buffer)))
             (proc-info (when proc
                         (let ((proc-id (process-id proc)))
                           (when proc-id
                             (condition-case err
                                 (let ((cmdline-file (format "/proc/%d/cmdline" proc-id)))
                                   (when (file-exists-p cmdline-file)
                                     (with-temp-buffer
                                       (insert-file-contents-literally cmdline-file)
                                       (buffer-string))))
                               (error nil))))))
             ;; Get TRAMP remote
             (tramp-remote (when (file-remote-p default-directory)
                            (let ((method-user-host (file-remote-p default-directory 'method-user-host)))
                              (when (and method-user-host
                                       (string-match "^/\\\\([^:]+\\\\):" method-user-host))
                                (match-string 1 method-user-host)))))
             ;; Build result object
             (result (list
                      (cons "name" (buffer-name))
                      (cons "path" (buffer-file-name))
                      (cons "exists" (if (buffer-file-name)
                                        (if (file-exists-p (buffer-file-name)) t :json-false)
                                      nil))
                      (cons "changed" (if (buffer-modified-p) t :json-false))
                      (cons "size" (buffer-size))
                      (cons "lines" (count-lines (point-min) (point-max)))
                      (cons "mode" (symbol-name major-mode))
                      (cons "eglot" (if (bound-and-true-p eglot--managed-mode) t :json-false))
                      (cons "ts" (if (and (fboundp 'treesit-available-p)
                                        (treesit-available-p)
                                        (fboundp 'treesit-language-at)
                                        (treesit-language-at (point)))
                                    t :json-false))
                      (cons "tramp" tramp-remote)
                      (cons "new" (if was-new t :json-false))
                      (cons "dead" :json-false)  ;; Will update if we kill the buffer
                      (cons "process" (if proc
                                        (list
                                         (cons "state" (symbol-name (process-status proc)))
                                         (cons "cmd" (or proc-info "")))
                                       nil))
                      (cons "point" (list
                                     (cons "pos" (point))
                                     (cons "line" (line-number-at-pos))
                                     (cons "col" (current-column))))
                      (cons "region" (if region-active
                                        (list
                                         (cons "content" region-content)
                                         (cons "truncated" (if region-truncated t :json-false))
                                         (cons "start" (list
                                                        (cons "pos" (region-beginning))
                                                        (cons "line" (line-number-at-pos (region-beginning)))
                                                        (cons "col" (save-excursion
                                                                     (goto-char (region-beginning))
                                                                     (current-column)))))
                                         (cons "end" (list
                                                      (cons "pos" (region-end))
                                                      (cons "line" (line-number-at-pos (region-end)))
                                                      (cons "col" (save-excursion
                                                                   (goto-char (region-end))
                                                                   (current-column))))))
                                       nil))
                      (cons "got" (list
                                   (cons "content" content)
                                   (cons "length" content-length)
                                   (cons "lines" content-line-count)
                                   (cons "start" (list
                                                  (cons "pos" content-start)
                                                  (cons "line" (line-number-at-pos content-start))
                                                  (cons "col" (save-excursion
                                                               (goto-char content-start)
                                                               (current-column)))))
                                   (cons "end" (list
                                                (cons "pos" content-end)
                                                (cons "line" (line-number-at-pos content-end))
                                                (cons "col" (save-excursion
                                                             (goto-char content-end)
                                                             (current-column)))))
                                   (cons "truncated" (if truncated t :json-false)))))))
        ${temp ? `
        ;; Restore state in temp mode
        (when original-point
          (goto-char original-point))
        ;; Kill buffer if it was newly created
        (when was-new
          (kill-buffer buf)
          ;; Update the dead flag in result
          (setf (alist-get "dead" result nil nil 'equal) t))` : ''}
        result))))`
}
