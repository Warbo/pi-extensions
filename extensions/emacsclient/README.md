# Emacsclient Extension - Implementation Plan

Issue: #82cd689974fb35cc, Comment 2
Requirement: Send TreeSitter-based edit commands through emacsclient, to edit
buffers directly in a structured way.

## Context

Currently pi edits files on disk, which conflicts with Emacs buffers. We need to:
1. Edit the Emacs buffer in-memory instead, by sending ELisp to emacsclient
2. Our ELisp should utilise Emacs's built-in TreeSitter support for syntax-aware
   structural edits
3. Allow querying of current Emacs state, including buffer list and content
   (scoped to regions).

## Extension Structure

Create `extensions/emacsclient/` with this layout:

```
extensions/emacsclient/
├── index.ts               # Tool registration and plumbing
├── query.ts               # TreeSitter query/edit functionality
├── test.sh                # Entry point for unit tests
├── query-test.mjs         # Unit tests of pure parts of JS functionality
├── emacs-integration.mjs  # Test w/ real emacsclient socket; mock Pi & LLM
└── pi-integration.mjs     # Test w/ real Pi, mock LLM & Emacs
```

## Three Tools to Register

### Tool 1: emacs_ts_query

Run a tree-sitter query against a buffer (restricted to region, if active), and
execute given elisp code for each match.

**Parameters:**
- `buffer` (required, string) - buffer name or file path
- `lang` (optional, string) - hint for tree-sitter language (js, python, etc.)
- `query` (required, tree-sitter query string) - Tree-sitter query with captures
  (e.g., `(function_definition) @func`). Quasiquoted, so Emacs Lisp can be
  spliced in (e.g. `,(treesit-node-at (point))`).
- `action` (optional, string of elisp code) - Expression to evaluate for each
  match. Result becomes an element of the returned list. Default, when not
  provided, will return the matched node as-is.

**In-scope values for `action`:**
- `@capture-name` - Each capture from the query becomes a variable holding the
  node
- `node` - The matched node (if single unnamed capture)
- `match` - Full match data structure

**Implementation:**
Sends ELisp to Emacs which will:
- Check if there's a buffer with the given name, if not then check if there's an
existing buffer for that path, and if not then try to open a buffer for that
path (failing if it doesn't exist).
- If the previous step gave us a buffer, open a `with-current-buffer` block for
  it...
- Run the given query, using the language hint (if any)...
- Loop/map over the matches (if any), executing `action` for each, serialising
  its results as strings, and accumulating them in a list.

**Returns:** { results: array of `action` results (one string per match), errors: error messages (if any) }

### Tool 2: emacs_list_buffers

List available buffers.

Returns: { buffers: [{name, filepath, modified, majorMode, size, visible}, ...] }

## Implementation Steps

*ALL* testing must go through `nix-build`! We do not have `node` etc. installed;
and we rely on Nix's sandboxing to avoid messing up our system!

### Step 1: Create plumbing/boilerplate (index.ts, test.sh, etc.)

### Step 2: Write unit tests (TDD style: RED)

Write tests for pure JS functions, aseerting (a) what should exist and (b) how
those things should behave. These tests won't interact with LLMs, Emacs or Pi.

### Step 3: Implement enough to make unit tests pass (TDD style: GREEN)

### Step 4: Write integration tests

**Emacs tests:** Write a bunch of tests that check our Emacs integration works,
e.g. Emacs will accept our generated elisp; we can parse the results Emacs
gives back; query the resulting state of Emacs by sending it elisp; etc. Nix
environment should spin up an Emacs instance with a server listening on a socket
that the tests will use (e.g. use an env var).

**Pi tests:** Write a bunch of tests that check our extension works with Pi.
Mock the Emacs and LLM interactions by giving canned responses.

### Step 5: Implement Emacs and Pi integrations until tests pass
