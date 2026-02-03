# TODO: Pi Extensions Repository

## Phase 1: Setup & Core Extension ✓

**Completed**: Repository setup, bash-permission extension with comprehensive test suite (14 unit tests, 2 integration tests), dummy LLM provider for testing, diagnosis of async blocking issue in pi's extension system.

See `PROJECT_SUMMARY.md` for details.

## Phase 2: Wrapper Script Implementation (IN PROGRESS)

### Context

Pi's extension events are asynchronous, so `tool_call` handlers cannot block execution reliably. Solution: Use a bash wrapper that creates a FIFO and blocks reading from it. Extension polls for FIFOs and writes decisions to them.

See `WRAPPER_ARCHITECTURE.md` for detailed design.

### Research Tasks

- [ ] **How pi invokes bash**
  - Test with `pi --mode rpc` to see actual invocation
  - Check if pi uses `bash` from PATH or hardcoded path
  - Determine how to make pi use our wrapper
  - Options: PATH manipulation, tool override, symlink

- [ ] **SHA256 consistency**
  - Verify bash `sha256sum` and Node.js `crypto` produce identical hashes
  - Test with edge cases: special chars, newlines, unicode
  - Command: `echo -n "test" | sha256sum` vs `crypto.createHash('sha256').update('test').digest('hex')`

- [ ] **FIFO behavior on Linux**
  - Test FIFO creation permissions
  - Test `read -t` timeout behavior
  - Test cleanup when process dies
  - Verify atomic operations

### Wrapper Implementation

- [ ] **Create `bash-wrapper.sh`**
  - Parse bash arguments (handle `-c "command"` format)
  - Calculate SHA256 of command
  - Call config checker for pre-allowed/denied commands
  - Create FIFO with unique name: `/tmp/pi-bash-perm-{hash}-{pid}.fifo`
  - Block on `read -t 30 decision < "$FIFO"`
  - Clean up FIFO after read (or timeout)
  - Execute real bash or deny based on decision

- [ ] **Create `check-command.mjs`** (Node.js helper)
  - Read `~/.config/pi/bash-permission.json`
  - Check exact matches (allowed/denied)
  - Check prefix matches (allowed/denied)
  - Return: "allow", "deny", or "unknown"
  - Share matching logic with main extension (extract to common module?)

- [ ] **Error handling in wrapper**
  - Config file missing → treat as empty config
  - Config malformed → deny by default, log error
  - SHA256 calculation fails → deny by default
  - mkfifo fails → deny by default
  - Real bash not found → exit with error
  - Unexpected decision value → deny

- [ ] **Wrapper testing**
  - Unit test: config checking with various commands
  - Integration test: create FIFO, simulate extension writing to it
  - Test timeout behavior (simulate no extension response)
  - Test cleanup on normal exit and on signals (SIGINT, SIGTERM)

### Extension Updates

- [ ] **Add FIFO monitoring**
  - Poll temp directory every 100ms for new FIFOs
  - Pattern: `/tmp/pi-bash-perm-*.fifo`
  - Track seen FIFOs to avoid duplicate processing
  - Parse filename to extract hash and PID

- [ ] **Handle FIFO requests**
  - When new FIFO detected, show UI dialog
  - Get user decision (allow/deny)
  - Write decision to FIFO: `fs.writeFileSync(fifoPath, "allow\n")`
  - Handle errors (FIFO disappeared, permission denied)

- [ ] **Stale FIFO cleanup**
  - On extension startup: scan for stale FIFOs
  - Check if PID from filename still exists
  - Remove FIFOs where PID is dead
  - Optional: periodic cleanup task every 5 minutes

- [ ] **Command tracking** (optional enhancement)
  - Before wrapper creates FIFO, extension could track command via tool_call event
  - Store mapping: hash → command
  - When FIFO appears, look up command by hash for better UI
  - This avoids showing just "hash: abc123..." in dialog

- [ ] **Configuration updates**
  - Add `wrapperEnabled` setting (default: true)
  - Add `wrapperRealBashPath` (default: "/usr/bin/bash")
  - Add `wrapperTempDir` (default: null = auto-detect)
  - Add `wrapperTimeout` (default: 30 seconds)

### Integration

- [ ] **Nix packaging**
  - Build wrapper with `writeShellScript`
  - Patch shebangs for wrapper and helper
  - Install to: `$out/extensions/bash-permission/bash-wrapper`
  - Install helper to: `$out/extensions/bash-permission/check-command.mjs`
  - Make both executable

- [ ] **Configure pi to use wrapper**
  - Research: how to override bash tool in pi
  - Option A: Modify PATH in extension's `session_start`
  - Option B: Create symlink and modify PATH
  - Option C: Ask user to configure pi settings
  - Document the chosen approach

- [ ] **Pass real bash path to wrapper**
  - Detect at runtime: `which bash` before modifying PATH?
  - Hardcode based on common locations: `/usr/bin/bash`, `/bin/bash`?
  - Make configurable via environment variable: `REAL_BASH`
  - Store in config file after first detection

### Testing

- [ ] **Update integration tests**
  - Test that denial now actually blocks execution
  - Test pre-allowed commands (fast path, no FIFO)
  - Test pre-denied commands (fast path, no FIFO)
  - Test unknown command with allow (creates FIFO, receives "allow")
  - Test unknown command with deny (creates FIFO, receives "deny")
  - Test timeout (wrapper creates FIFO, extension never responds)
  - Test concurrent requests (multiple wrappers, multiple FIFOs)

- [ ] **End-to-end testing**
  - Run pi with wrapper in interactive mode
  - Test actual bash commands being blocked/allowed
  - Verify config persistence works
  - Test /permissions command
  - Test with real workloads (not just tests)

- [ ] **Test in Nix sandbox**
  - Ensure wrapper works in isolated environment
  - Verify temp directory handling
  - Check that all tests pass via `nix-build`

### Documentation

- [ ] **Update `README.md`**
  - Document wrapper architecture (high-level)
  - Update installation instructions
  - Explain configuration options
  - Remove/update "Known Limitations" section

- [ ] **Update `KNOWN_ISSUES.md`**
  - Mark async issue as "RESOLVED by wrapper approach"
  - Document any wrapper-specific limitations
  - Keep original diagnosis for historical reference

- [ ] **Update `TESTING_SUMMARY.md`**
  - Add wrapper testing section
  - Show before/after comparison
  - Document that blocking now works

- [ ] **Simplify documentation**
  - Remove alternatives (we're doing wrapper)
  - Remove excessive detail from completed tasks
  - Focus on what's relevant going forward

## Phase 3: Future Enhancements

- [ ] **Extend to other tools**: Apply wrapper pattern to `write`, `read`, etc.
- [ ] **Command caching**: Remember recent decisions temporarily to avoid repeated prompts
- [ ] **Learning mode**: Suggest rules based on user patterns
- [ ] **Better UI**: Show full command in dialog (requires command tracking)
- [ ] **Performance optimization**: Use inotify instead of polling (Linux-specific)
- [ ] **LLM safety analysis**: Ask weak model for command safety summary

## Phase 4: Repository Expansion

- [ ] **Additional extensions**: File protection, git safety, network safety, etc.
- [ ] **Distribution**: Publish as npm package
- [ ] **CI/CD**: Automated testing on commits
- [ ] **Contribution workflow**: Issue templates, PR templates
