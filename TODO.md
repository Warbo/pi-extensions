# TODO: Pi Extensions Repository

## Phase 1: Setup & Research ✓

- [x] Review pi extension documentation
- [x] Study example extensions (permission-gate.ts, confirm-destructive.ts)
- [x] Understand extension API and event system
- [x] Initialize git repository structure
- [x] Create README.md with repository overview
- [x] Set up `default.nix` to build and test this project
- [x] Set up `shell.nix` to provide dev tools
- [x] Set up basic TypeScript configuration (if needed for development)

## Phase 2: Bash Permission Extension (First Extension)

### Core Functionality ✓

- [x] Create `bash-permission/index.ts` extension file
- [x] Implement `tool_call` event handler for bash tool interception
- [x] Initial approach: require confirmation for ALL commands.
- [x] Implement confirmation dialog using `ctx.ui.select()`
- [x] Allow multiple options:
  - ✅ Deny once
  - ✅ Allow once
  - ✅ Deny prefix
  - ✅ Allow exact command
  - ✅ Allow prefix. For example, if we're asked to confirm the command
    `git add foo.txt`, we might allow `git add` followed by anything.
- [x] Handle non-interactive mode (when `ctx.hasUI` is false)
  - ✅ Allow saved confirmations, but deny anything unknown.

### Configuration System ✓

- [x] Design configuration file format (JSON)
  - ✅ Approvals which have been remembered (allowedExact, allowedPrefixes)
  - ✅ Denials which have been remembered (deniedExact, deniedPrefixes)
  - ✅ Timeout settings for confirmation dialog
- [x] Implement config file loading from:
  - ✅ `~/.config/pi/bash-permission.json` (global)

### User Experience

- [x] Display the actual command in confirmation dialog
- [x] Add "Deny once" option. Blocks command, doesn't alter config.
- [x] Add "Allow once" option. Runs command, doesn't alter config.
- [x] Add "Deny prefix" option, with text entry for prefix. Defaults to whole
      command. Blocks command, remembers prefix and blocks anything matching it.
- [x] Add "Allow exact" option. Runs command, remembers that it's allowed.
- [x] Add "Allow prefix" option, with text entry for prefix. Defaults to whole
      command. Runs command, remembers prefix and allows anything matching it.
- [x] Implement timeout option for auto-deny after N seconds
- [x] Added `/permissions` command to view and manage rules
- [ ] Ask weak model for short summary of a command's safety.
- [ ] Ask weak model for safer alternatives.

### Testing ✓

- [x] Test with various (benign) commands
- [x] Test configuration file loading and saving
- [x] Test exact match (allow and deny)
- [x] Test prefix match (allow and deny)
- [x] Test priority ordering (exact deny > exact allow > prefix deny > prefix allow)
- [x] Test edge cases:
  - ✅ Multi-line commands
  - ✅ Commands with escaped characters
  - ✅ Piped commands
  - ✅ Empty prefix handling
- [x] Created automated test suite (14 unit tests, TAP format)
- [x] Tests run via `nix-build` in sandbox
- [x] Created RPC-based integration tests (4 passing)
  - ✅ Permission dialog appears for bash commands
  - ✅ Allow once permits command execution
  - ✅ Allow exact saves configuration
  - ✅ Allow prefix prompts for prefix input
  - ⚠️  Deny blocking has timing issues in RPC mode (works in interactive)
- [x] Created dummy LLM provider for testing without network access
- [ ] Manual integration testing with pi (interactive mode)
- [ ] Manual integration testing with pi (non-interactive mode)

### Documentation ✓

- [x] Create `bash-permission/README.md` with:
  - ✅ Installation instructions
  - ✅ Configuration options
  - ✅ Usage examples
  - ✅ FAQ section
- [x] Add inline code comments
- [x] Create example configuration files
  - ✅ bash-permission.example.json
  - ✅ config.schema.json

## Phase 3: Repository Structure ✓

- [x] Organize extensions in subdirectories:
  ```
  extensions/
  ├── bash-permission/
  │   ├── index.ts
  │   ├── README.md
  │   ├── config.schema.json
  │   └── examples/
  │       └── bash-permission.example.json
  ├── [future-extension]/
  └── README.md (placeholder)
  ```
- [x] Create root README.md with:
  - ✅ Overview of all extensions
  - ✅ Installation instructions
  - ✅ How to use extensions with pi
- [x] Add LICENSE file (Public Domain)
- [x] Add .gitignore for TypeScript/Node.js

## Phase 4: Future Extensions (Ideas)

- [ ] **File protection extension**: Block writes to sensitive files/directories
- [ ] **Git safety extension**: Confirm before force push, branch deletion, etc.
- [ ] **Resource monitor**: Warn about commands that might use excessive CPU/memory
- [ ] **Network safety**: Confirm before commands that expose services
- [ ] **Backup prompt**: Suggest creating backup before destructive operations
- [ ] **Time-based restrictions**: Block certain commands during specific hours
- [ ] **Context-aware permissions**: Different rules based on current directory

## Phase 5: Distribution & Maintenance

- [ ] Test installation via `pi -e ./path/to/extension.ts`
- [ ] Test installation via `~/.pi/agent/extensions/`
- [ ] Consider publishing as npm package (see docs/packages.md)
- [ ] Set up CI/CD for automated testing
- [ ] Create issue templates for bug reports and feature requests
- [ ] Set up contribution workflow (PR templates, etc.)
- [ ] Version management strategy

## Research Notes

### Key Findings from Documentation

1. **Extension locations**: 
   - Global: `~/.pi/agent/extensions/*.ts`
   - Project-local: `.pi/extensions/*.ts`
   - Via flag: `pi -e ./extension.ts`

2. **Event system**: 
   - `tool_call` fires before tool execution, can block via `{ block: true, reason: "..." }`
   - `ctx.hasUI` indicates if interactive dialogs are available
   - Extensions should handle both interactive and non-interactive modes

3. **UI methods**:
   - `ctx.ui.select()` - multiple choice
   - `ctx.ui.confirm()` - yes/no
   - `ctx.ui.notify()` - non-blocking notification
   - Dialogs support timeout option with countdown

4. **Best practices**:
   - Use TypeScript with proper types from `@mariozechner/pi-coding-agent`
   - Handle AbortSignal for cancellation
   - Always check `ctx.hasUI` before using UI methods
   - Provide fallback behavior for non-interactive mode

### Reference Extensions to Study

- `permission-gate.ts` - Basic permission checking (our starting point)
- `confirm-destructive.ts` - Session action confirmation
- `protected-paths.ts` - File protection example (likely)
- `timed-confirm.ts` - Confirmation with timeout

## Questions/Decisions Needed

- [ ] Should the extension be opt-in (no warnings by default) or opt-out (warn by default)?
- [ ] What should be the default timeout for confirmation dialogs?
- [ ] Should we maintain a community-curated list of dangerous patterns?
- [ ] How strict should the matching be? (exact match vs fuzzy/heuristic)
- [ ] Should we support learning mode (track user decisions to improve patterns)?
