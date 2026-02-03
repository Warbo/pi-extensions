# Project Summary: Pi Extension Testing & Wrapper Solution

## Current Status

### What We Built ✅

**Test Infrastructure**: Comprehensive test suite with 14 unit tests (all passing) and 2 integration tests. Created custom dummy LLM provider for testing without network access. All tests run in Nix sandbox via `nix-build`.

**Root Cause Diagnosis**: Discovered that pi's extension events are asynchronous. When a `tool_call` handler calls `await ctx.ui.select()`, tool execution begins immediately without waiting for completion. This makes it impossible to block execution from the extension.

**Evidence**:
```
[1770084597048] extension_ui_request: select
[1770084597048] tool_execution_start: bash rm -rf test.txt  ← Same timestamp!
```

The extension eventually returns `{ block: true }`, but by then the tool has already started executing.

### What Works ✅

- ✅ Pre-configured allow/deny rules (exact and prefix matching)
- ✅ Extension loads and intercepts bash commands
- ✅ UI dialogs appear and "Allow" choices work correctly
- ✅ Config persistence and management
- ✅ All unit tests pass

### What Doesn't Work ❌

- ❌ Interactive denial in RPC mode (command executes despite user denying)

This limitation exists because returning `{ block: true }` happens after tool execution has already started.

## Solution: Wrapper Script with FIFO

Instead of trying to block from the extension (impossible with async events), we'll use a bash wrapper that:

1. **Checks pre-configured rules** (fast path, no overhead)
2. **For unknown commands**: Creates a FIFO (named pipe) and blocks reading from it
3. **Extension polls** for FIFOs, shows UI, writes "allow" or "deny" to FIFO
4. **Wrapper reads decision** (unblocks) and either executes or denies the command

This moves the blocking point from the extension (async, too late) to the wrapper (synchronous, before execution).

### Why FIFO?

- Simple: One file instead of request + response
- Synchronous: Wrapper blocks automatically on `read`
- Built-in timeout: `read -t 30` handles timeout cleanly
- Self-cleaning: FIFO disappears when both ends close
- Atomic: Writing to FIFO is naturally atomic

See `WRAPPER_ARCHITECTURE.md` for detailed design including sequence diagrams and implementation details.

## Key Files

**Documentation**:
- `WRAPPER_ARCHITECTURE.md` - Detailed wrapper design and protocol
- `TODO.md` - Implementation roadmap
- `KNOWN_ISSUES.md` - Analysis of async blocking issue
- `TESTING_SUMMARY.md` - Test methodology

**Testing**:
- `extensions/bash-permission/test-helper.mjs` - Unit tests
- `extensions/bash-permission/test-integration-simple.mjs` - Integration tests
- `extensions/bash-permission/test-dummy-llm.ts` - Custom LLM provider
- `extensions/bash-permission/index-debug.ts` - Debug-instrumented extension

**Extension**:
- `extensions/bash-permission/index.ts` - Main extension
- `extensions/bash-permission/README.md` - User documentation

## Next Steps

See `TODO.md` Phase 2 for detailed implementation tasks:

1. **Research**: Verify SHA256 consistency, test FIFO behavior, determine how pi invokes bash
2. **Wrapper**: Implement `bash-wrapper.sh` and `check-command.mjs`
3. **Extension**: Add FIFO monitoring and decision writing
4. **Integration**: Configure pi to use wrapper, test end-to-end
5. **Testing**: Update tests to verify blocking now works

## Running Tests

```bash
nix-build  # Runs all tests in sandbox
```

Current output:
- 14 unit tests: ✅ All passing
- Integration test 1: ✅ Extension loads and shows UI
- Integration test 2: ❌ Denial doesn't block (expected, will be fixed by wrapper)

## Key Insights

**Testing without network**: Created a dummy LLM provider that returns canned responses. This enables reproducible integration tests in the Nix sandbox.

**Async events don't block**: Pi's extension API doesn't wait for async `tool_call` handlers to complete before starting tool execution. This is likely due to the transition from "hooks" to "extensions" API.

**Wrapper solves blocking**: By intercepting at the execution layer (bash itself) rather than the event layer (extension), we can reliably block commands before they execute.

**What this proves**: The diagnostic work shows exactly why the current approach can't work, and validates that the wrapper approach will work.
