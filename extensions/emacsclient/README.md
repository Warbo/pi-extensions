# Emacsclient Extension for Pi

A Pi extension that enables direct interaction with a running Emacs session. Instead of editing files on disk, Pi can read and manipulate Emacs buffers in-memory, query buffer state, and perform syntax-aware operations using Emacs's built-in Tree-sitter support.

## Features

- **Direct buffer access**: Read and query Emacs buffers without touching the filesystem
- **Tree-sitter integration**: Run structural queries and perform syntax-aware edits
- **State management**: Navigate buffers, move point, and maintain editing context
- **Emacs Lisp evaluation**: Execute arbitrary elisp in your running Emacs session

## Requirements

- A running Emacs server (Emacs 29+ recommended for Tree-sitter support)
- `emacsclient` binary in your PATH

To start an Emacs server:
```bash
# Start Emacs as a daemon
emacs --daemon

# Or from within Emacs
M-x server-start
```

## Installation

1. Copy this directory to your pi extensions folder:
   ```bash
   cp -r extensions/emacsclient ~/.config/pi/extensions/
   ```

2. Enable the extension in your pi configuration (if not auto-loaded)

## Configuration

By default, the extension connects to your default Emacs server socket. To use a custom socket:

```bash
export EMACS_SOCKET_NAME=/path/to/socket
```

For testing, you can override the emacsclient binary:
```bash
export EMACSCLIENT_BINARY=/custom/path/to/emacsclient
```

## Tools

### `read`
Read the content and metadata of a file or Emacs buffer.

**Parameters:**
- `name` (required): Path if it starts with `/` (absolute) or `./`/`../` (relative); otherwise a buffer name. If no buffer with that name exists: names with special chars (`*`, `/`, `<`, `>`) create a bare buffer with no file association (use `*name*` for temp buffers); plain names open/create a file as if preceded by `./`. Supports TRAMP paths.
- `pos` (optional): Character position to start reading (1-indexed, or negative for relative to point)
- `line` (optional): Line number to start reading
- `col` (optional): Column number (used with `line`)
- `length` (optional): Maximum characters to read (default: 51200)
- `lines` (optional): Maximum lines to read
- `span` (optional): Narrow to a span ID (result of a previous read)
- `temp` (optional): If true, don't modify Emacs state (default: false)

**Returns:** Buffer content, metadata (major mode, size, point position, etc.)

**Example:**
```typescript
// Read first 1000 characters of a file (also moves point)
read({ name: "./src/main.ts", pos: 1, length: 1000 })
// Read subsequent 1000 characters from that file (starts at point)
read({ name: "./src/main.ts", length: 1000 })

// Read 50 lines starting from line 100
read({ name: "./main.ts", line: 100, lines: 50 })

// Peek at a file without affecting Emacs state
read({ name: "./config.json", temp: true })

// Read within a span from a previous read
read({ name: "./config.json", span: "span-id-from-previous-read" })
```

### `write`
Insert text into Emacs buffer at a specific position, and optionally type a key sequence. Can create new files/buffers, move point, insert content, type keys, and save.

**Parameters:**
- `name` (required): Path if it starts with `/` (absolute) or `./`/`../` (relative); otherwise a buffer name. If no buffer with that name exists: names with special chars (`*`, `/`, `<`, `>`) create a bare buffer with no file association (use `*name*` for temp buffers); plain names open/create a file as if preceded by `./`. Supports TRAMP paths.
- `insert` (optional): Text to insert at the specified position
- `pos` (optional): Position to insert at (1-indexed, or negative for relative to end). Conflicts with `line`, `point`, `replace`
- `line` (optional): Line number to insert at (1-indexed, or negative for relative to end). Conflicts with `pos`, `point`, `replace`
- `point` (optional): If true, insert at point (start of file if newly opened). Default when no `pos` or `line` given. Conflicts with those
- `type` (optional): Keyboard macro to type in buffer (via 'kbd'). Runs after insert and before save
- `replace` (optional): If true, clear buffer contents before inserting. Makes `point`, `pos`, `line` meaningless
- `save` (optional): If buffer is backed by a file, save it after inserting. Creates parent directories if needed (default: true)
- `temp` (optional): If true, restore Emacs state afterwards - killing new buffers, restoring point in existing buffers (default: false)

**Returns:** Updated buffer metadata

**Example:**
```typescript
// Insert text at the beginning of a file
write({ name: "./README.md", insert: "# Title\n\n", pos: 1 })

// Append text to a buffer
write({ name: "notes", insert: "\nNew note", pos: -1 })

// Insert at current point and save
write({ name: "./src/main.ts", insert: "// TODO: review\n", point: true, save: true })

// Create a new file with content
write({ name: "./newfile.txt", insert: "Hello, world!", replace: true })

// Replace entire buffer content (use *name* for a bare buffer with no file association)
write({ name: "*pi-scratch*", insert: "Fresh content", replace: true })

// Insert without affecting Emacs state
write({ name: "./config.json", insert: "new config", pos: 1, temp: true })

// Type a key sequence in the buffer
write({ name: "main.py", type: "C-x C-s" })
```

### `emacs_eval`
Evaluate an Emacs Lisp expression and return the result.

**Parameters:**
- `expression` (required): Elisp code to evaluate

**Returns:** The result of evaluating the expression

**Example:**
```typescript
// Get current buffer name
emacs_eval({ expression: "(buffer-name)" })

// List all buffers
emacs_eval({ expression: "(mapcar #'buffer-name (buffer-list))" })

// Get value of a variable
emacs_eval({ expression: "default-directory" })
```

### `emacs_list_buffers`
List all open Emacs buffers with metadata.

**Parameters:** None

**Returns:** Array of buffer information:
- `name`: Buffer name
- `filepath`: Associated file path (if any)
- `unsaved`: Whether buffer has unsaved changes
- `majorMode`: Major mode (e.g., "python-mode")
- `size`: Buffer size in characters
- `visible`: Whether buffer is currently visible

**Example:**
```typescript
emacs_list_buffers({})
```

### `emacs_ts_query`
Run a Tree-sitter query against an Emacs buffer and optionally execute elisp for each match.

**Parameters:**
- `buffer` (required): Buffer name or file path
- `query` (required): Tree-sitter query string with `@captures`
- `lang` (optional): Language hint (e.g., "python", "javascript")
- `action` (optional): Elisp expression to evaluate for each match

**Returns:** An object containing:
- `results`: Array of results (one per match)
- `count`: Number of matches found

**Examples:**
```typescript
// Find all function definitions
emacs_ts_query({
  buffer: "main.py",
  query: "(function_definition name: (identifier) @name)",
  lang: "python"
})

// Get function names and their starting positions
emacs_ts_query({
  buffer: "main.py",
  query: "(function_definition name: (identifier) @name)",
  action: "(cons (treesit-node-text name) (treesit-node-start name))"
})

// Find all import statements
emacs_ts_query({
  buffer: "app.ts",
  query: "(import_statement) @import",
  lang: "typescript"
})
```

## Use Cases

### Avoiding Buffer Conflicts
Reading Emacs buffers ensures unsaved changes are seen; editing Emacs buffers avoids conflicting changes.

### Syntax-Aware Refactoring
Use Tree-sitter queries to find and modify code structures precisely:
- Rename functions/classes
- Add parameters to function signatures
- Extract code to functions
- Reorganize imports

### Context-Aware Assistance
Pi can query your current Emacs state to provide more relevant help:
- See what files you have open
- Know where point is positioned
- Understand the major mode and language context

### Interactive Development
Combine reading and evaluation for complex workflows:
1. Read a section of code
2. Analyze it
3. Execute elisp to perform edits
4. Query the result to verify changes

## Development

### Running Tests

The extension includes comprehensive tests. It is recommended to use `nix-build`, via the
`default.nix` file in this repo's root:

```bash
nix-build ../.. -A extensions.emacsclient
```

Test suites:
- **Unit tests** (`unit_test.test.ts`): Test pure functions
- **Emacs integration tests** (`emacs-integration.test.ts`): Test emacsclient interaction
- **Pi integration tests** (`pi-integration.test.ts`): Test extension API integration
- **Read tool tests** (`read-tool.test.ts`, `read-tool-integration.test.ts`): Test the read tool

### Architecture

- `index.ts`: Tool registration and Pi API integration
- `emacsclient.ts`: Low-level emacsclient invocation
- `elisp.ts`: Elisp code generation and output parsing
- `*.test.ts`: Test suites

## Troubleshooting

### "emacsclient: can't find socket"
Make sure your Emacs server is running:
```elisp
M-x server-start
```

Or start Emacs as a daemon:
```bash
emacs --daemon
```

### "Wrong type argument: treesit-node-p"
Your buffer needs a Tree-sitter parser. Emacs 29+ with Tree-sitter grammars installed is required. Check with:
```elisp
M-: (treesit-available-p)
```

### Timeout errors
Increase the timeout for long-running operations by setting `EMACSCLIENT_TIMEOUT`:
```bash
export EMACSCLIENT_TIMEOUT=30000  # 30 seconds
```

## License

Public domain
