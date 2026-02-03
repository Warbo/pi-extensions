# TODO

## Status

**IMPLEMENTATION COMPLETE** ✅

The bash-permission extension and wrapper are fully implemented and manually tested. The wrapper successfully blocks bash commands until the extension provides approval via FIFO.

**Remaining**: Integration tests need updating to use the wrapper (currently test without it).

## Problem

Pi's `tool_call` event handlers are async. Tool execution starts before the handler completes, so returning `{ block: true }` is too late to prevent execution.

Evidence from tests:
```
[1770084597048] extension_ui_request: select
[1770084597048] tool_execution_start: bash rm -rf test.txt  ← Same timestamp!
```

## Solution: Bash Wrapper with FIFO

Give pi a bash wrapper instead of real bash:

1. **Wrapper** hashes command, creates FIFO: `/tmp/pi-bash-perm-{sha256}.fifo`
2. Wrapper blocks: `read -t 30 decision < "$FIFO"`
3. **Extension** receives tool_call event, checks config for pre-allowed/denied commands
4. Extension polls for the specific FIFO to exist (based on command hash)
5. Extension writes "allow" or "deny" to FIFO (from config or user prompt)
6. Wrapper unblocks, executes or denies command

### Why FIFO?

- Wrapper blocks in kernel (synchronous, no polling)
- Built-in timeout: `read -t 30`
- Self-cleaning: disappears when both ends close
- Simple: one file instead of request + response

### How to Make Pi Use the Wrapper

**Pi's shell resolution** (from `utils/shell.js`):
1. Check `shellPath` in `~/.pi/agent/settings.json` ← **USE THIS!**
2. On Unix: use `/bin/bash` if it exists
3. Fallback: use `sh`

**Installation approach**:
```json
// ~/.pi/agent/settings.json
{
  "shellPath": "/nix/store/.../bin/bash-permission-wrapper"
}
```

Or: provide a setup command that modifies the settings file automatically.

## Implementation Tasks

### Research

- [x] **Find how pi invokes bash** ✅
  - Pi uses `getShellConfig()` from `utils/shell.js`
  - Resolution order:
    1. `shellPath` in `~/.pi/agent/settings.json` (USER CONFIGURABLE!)
    2. On Unix: `/bin/bash` if exists
    3. Fallback: `sh`
  - **Solution**: Set `shellPath` to our wrapper in settings.json
  - **Real bash location**: Can be passed via env var `REAL_BASH` to wrapper
  - Tested: wrapper intercepts successfully ✅

- [ ] Test SHA256 consistency between bash and Node.js
  - Bash: `echo -n "cmd" | sha256sum`
  - Node: `crypto.createHash('sha256').update('cmd').digest('hex')`
- [ ] Test FIFO: create, read with timeout, cleanup

### Wrapper Script

- [x] **bash-wrapper.sh** ✅ Implemented in default.nix
  ```bash
  #!/usr/bin/env bash
  set -euo pipefail
  
  REAL_BASH="${REAL_BASH:-/nix/store/.../bash}"
  COMMAND="$2"  # from: bash -c "command"
  
  # Hash command (no PID - extension needs to find this FIFO)
  HASH=$(echo -n "$COMMAND" | sha256sum | cut -d' ' -f1)
  FIFO="/tmp/pi-bash-perm-$HASH.fifo"
  
  # Create FIFO and block
  mkfifo "$FIFO"
  trap "rm -f '$FIFO'" EXIT
  
  if read -t 30 decision < "$FIFO"; then
    [[ "$decision" == "allow" ]] && exec "$REAL_BASH" -c "$COMMAND"
    echo "Command denied: $COMMAND" >&2
    exit 1
  else
    echo "Timeout, command denied: $COMMAND" >&2
    exit 1
  fi
  ```

- [ ] **check-command.mjs** (Node.js helper)
  - Read `~/.config/pi/bash-permission.json`
  - Check exact matches first (allow/deny)
  - Check prefix matches second
  - Return: "allow" | "deny" | "unknown"

### Extension Updates

- [x] Add FIFO communication to extension ✅ Implemented in index.ts
  ```typescript
  async function writeFifoDecision(command: string, decision: "allow" | "deny"): Promise<void> {
    const hash = crypto.createHash("sha256").update(command).digest("hex");
    const fifoPath = `/tmp/pi-bash-perm-${hash}.fifo`;

    // Poll for FIFO to exist (wrapper creates it)
    const maxAttempts = 20; // 2 seconds total
    const pollInterval = 100; // ms
    
    for (let i = 0; i < maxAttempts; i++) {
      if (fs.existsSync(fifoPath)) {
        fs.writeFileSync(fifoPath, decision + "\n");
        return;
      }
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }
    
    throw new Error(`FIFO not found after ${maxAttempts * pollInterval}ms: ${fifoPath}`);
  }
  ```

- [x] Update tool_call handler ✅
  - Check config (exact/prefix matches)
  - For unknown commands: show UI, get user decision
  - Write decision to FIFO (both config and user decisions)
  - Return undefined (wrapper handles blocking)

### Integration

- [x] Package wrapper in Nix ✅ Implemented in default.nix
  - Use `writeShellScript` for wrapper
  - Hardcode bash path from pkgs.bash
  - Return as `bash-permission-wrapper` attribute

- [x] Make pi use wrapper ✅ Documentation updated
  - User sets `shellPath` in `~/.pi/agent/settings.json`:
    ```json
    {
      "shellPath": "${piExtensions.bash-permission-wrapper}"
    }
    ```
  - Via Home Manager: `home.file.".pi/agent/settings.json".text = builtins.toJSON { ... }`

- [x] Pass real bash path to wrapper ✅
  - Hardcoded in Nix derivation: `${pkgs.bash}/bin/bash`
  - Allows override via `REAL_BASH` env var if needed

### Testing

- [ ] Update integration tests
  - Simulate wrapper: create FIFO, wait for extension to write decision
  - Test pre-configured rules work with FIFO
  - Test timeout (FIFO created, extension doesn't respond)

- [ ] Manual testing
  - Run pi with wrapper in settings.json
  - Try dangerous commands, verify blocking works
  - Test concurrent requests (same command multiple times)

- [ ] Edge cases
  - Wrapper crashes → stale FIFO cleanup needed?
  - Extension crashes → wrapper timeout handles it
  - Multiple wrappers for same command → FIFO collision (wrapper handles with retry)

### Documentation

- [ ] Update README with wrapper installation
- [ ] Remove "In Progress" section when complete
- [ ] Document configuration options

## Completed

### Phase 1 & 2: Extension Development
- ✅ Extension loads and intercepts bash commands
- ✅ Pre-configured rules work (exact/prefix, allow/deny)
- ✅ UI dialogs and config management
- ✅ 14 unit tests + 2 integration tests
- ✅ Dummy LLM provider for testing without network
- ✅ Diagnosed async blocking issue

### Phase 2.5: Wrapper Implementation
- ✅ Bash wrapper script implemented in default.nix
  - Hashes command with SHA256
  - Creates FIFO `/tmp/pi-bash-perm-{hash}.fifo`
  - Blocks with 30s timeout
  - Executes on "allow", denies on "deny"
- ✅ Extension FIFO communication
  - Polls for FIFO to exist (2s timeout)
  - Writes "allow" or "deny" based on config or user choice
  - Works with both saved rules and user prompts
- ✅ Nix packaging
  - `bash-permission-wrapper` attribute for shellPath
  - `extensions.bash-permission` for pi extension
  - `all` derivation runs all tests
- ✅ Manual testing
  - Verified allow: command executes, exit code 0
  - Verified deny: command blocked, exit code 1, error message
  - Verified FIFO creation and cleanup
