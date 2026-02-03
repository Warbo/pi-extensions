# TODO

## Current Test Status

### Unit Tests: 14/14 PASSING ✅
- Config loading and saving
- Command matching (exact/prefix, allow/deny)
- Priority rules
- Edge cases

### Integration Tests: FAILING ❌

**Simple integration tests (test-integration-simple.mjs)**: 0/2 passing
- Both tests fail immediately
- **Root cause**: Pi rejects model "dummy/dummy-model"
  ```
  # pi stderr: Model dummy/dummy-model not found
  # Pi process exited with code 1, signal null
  ```
- The dummy LLM extension (test-dummy-llm.ts) isn't being recognized as a valid provider
- Need to fix how dummy extension registers itself or how we specify the provider/model

**Full integration tests (test-integration.mjs)**: 3/4 passing
- ✅ Test 1: Permission dialog appears for bash command
- ✅ Test 2: Allow once permits command
- ✅ Test 3: Allow exact saves to config
- ❌ Test 4: Allow prefix prompts for prefix (timeout)

## Remaining Work

### Fix Test Infrastructure
- [ ] Fix dummy LLM provider registration
  - Currently pi can't find "dummy/dummy-model"
  - May need to register as a proper provider
  - Or find the correct way to specify it in RPC mode
  
- [ ] Debug test 4 timeout in full integration tests
  - "Allow prefix prompts for prefix" times out waiting for event
  - Likely a test logic issue, not a wrapper issue

### Testing
- [ ] Verify wrapper works end-to-end once tests pass
- [ ] Test edge cases:
  - Concurrent commands (same hash)
  - Wrapper timeout when extension doesn't respond
  - FIFO cleanup on errors

### Documentation
- [ ] Update README with installation instructions
- [ ] Document how to configure shellPath
- [ ] Add troubleshooting section

## Architecture Summary

**Implementation is complete**, just needs test fixes.

### How It Works

1. User configures `shellPath` in `~/.pi/agent/settings.json` to point to wrapper
2. When pi executes bash command, wrapper intercepts it:
   - Hashes command: `sha256(command)` → hash
   - Creates FIFO: `${TMPDIR:-/tmp}/pi-bash-perm-{hash}.fifo`
   - Blocks reading from FIFO (30s timeout)
3. Extension receives `tool_call` event:
   - Checks config for pre-allowed/denied commands
   - Polls for FIFO to exist (10s timeout, 100ms intervals)
   - Writes "allow" or "deny" to FIFO
4. Wrapper unblocks and either executes command or exits with error

### Key Design Decisions

- **FIFO-based IPC**: Wrapper blocks synchronously in kernel, no busy polling
- **SHA256 hash in filename**: Both sides compute same hash from command
- **No PID in FIFO name**: Wrapper and extension must agree on filename
- **Wrapper has zero logic**: Only creates FIFO and waits, all decisions in extension
- **Extension owns all decisions**: Config checking and user prompts
- **Temp dir from env**: Respects `TMPDIR`, falls back to `/tmp`

### File Locations

- Wrapper: `bash-permission-wrapper` (Nix derivation output)
- Extension: `extensions/bash-permission/index.ts`
- Config: `~/.config/pi/bash-permission.json`
- Settings: `~/.pi/agent/settings.json` (or `$PWD/.pi/agent/settings.json`)
- FIFO: `${TMPDIR:-/tmp}/pi-bash-perm-{sha256}.fifo`
- Debug logs (tests only):
  - `${TMPDIR:-/tmp}/bash-permission-wrapper-{pid}.log`
  - `${TMPDIR:-/tmp}/bash-permission-ext-{pid}.log`
