# Known Issues

## Interactive Denial in RPC Mode (RESOLVED)

**Status**: Resolved by wrapper script approach  
**Affects**: RPC mode only (interactive TUI mode likely works)

### Problem

When an extension's `tool_call` event handler makes an async UI call (e.g., `ctx.ui.select()`), the tool execution begins **before** the handler completes and returns its blocking decision.

### Evidence

From integration test with timestamps:

```
[BASH-PERM-DEBUG] Calling ctx.ui.select...
[1770084597048] extension_ui_request: select
[1770084597048] tool_execution_start: bash rm -rf test.txt  ← Same timestamp!
... user responds 30ms later ...
[BASH-PERM-DEBUG] UI select returned: ❌ Deny once
[BASH-PERM-DEBUG] Denying once  ← Too late, tool already started!
```

Both `extension_ui_request` and `tool_execution_start` occur at the **same millisecond**, proving that tool execution doesn't wait for the async handler to complete.

### Root Cause

Pi's extension events are asynchronous. The `tool_call` handler is invoked but not awaited before tool execution begins. This is likely due to pi's transition from the old "hooks" mechanism (which may have supported blocking) to the current "extensions" API.

### Impact

- ❌ Interactive "Deny once" doesn't block in RPC mode
- ✅ Pre-configured deny rules work (no async UI needed)
- ✅ Pre-configured allow rules work
- ✅ Interactive allow works (tool already started, so allowing is fine)

### Solution: Wrapper Script

Instead of blocking from the extension (impossible with async events), we use a bash wrapper that:

1. Checks pre-configured rules (fast path, no extension involvement)
2. For unknown commands, creates a FIFO (named pipe)
3. Blocks reading from FIFO (synchronous wait)
4. Extension detects FIFO, shows UI, writes decision to FIFO
5. Wrapper unblocks, reads decision, executes or denies

This moves the blocking point from the extension layer (async, too late) to the execution layer (synchronous, before command runs).

See `../WRAPPER_ARCHITECTURE.md` for detailed design.

### Historical Context

This document preserves the diagnosis that led to the wrapper solution. The original extension code attempted to block via `return { block: true }` from an async `tool_call` handler, which doesn't work due to pi's event architecture.

The diagnostic work proved:
1. Why the current approach can't work
2. Exactly when execution starts (before handler completes)
3. That we need synchronous blocking at a lower level

This informed the wrapper design and validates that it will solve the problem.
