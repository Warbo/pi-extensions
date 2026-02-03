# TODO

## Problem

Pi's `tool_call` event handlers are async. Tool execution starts before the handler completes, so returning `{ block: true }` is too late to prevent execution.

Evidence from tests:
```
[1770084597048] extension_ui_request: select
[1770084597048] tool_execution_start: bash rm -rf test.txt  ← Same timestamp!
```

## Solution: Bash Wrapper with FIFO

Give pi a bash wrapper instead of real bash:

1. **Wrapper** checks config for pre-allowed/denied commands (fast path)
2. For unknown commands, wrapper creates FIFO: `/tmp/pi-bash-perm-{sha256}-{pid}.fifo`
3. Wrapper blocks: `read -t 30 decision < "$FIFO"`
4. **Extension** polls temp dir for new FIFOs every 100ms
5. Extension shows UI, writes "allow" or "deny" to FIFO
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

- [ ] **bash-wrapper.sh**
  ```bash
  #!/usr/bin/env bash
  set -euo pipefail
  
  REAL_BASH="/usr/bin/bash"
  COMMAND="$2"  # from: bash -c "command"
  
  # Check config via Node.js helper
  DECISION=$(node check-command.mjs "$COMMAND")
  
  if [[ "$DECISION" == "allow" ]]; then
    exec "$REAL_BASH" "$@"
  elif [[ "$DECISION" == "deny" ]]; then
    echo "Denied: $COMMAND" >&2
    exit 1
  fi
  
  # Unknown: create FIFO and block
  HASH=$(echo -n "$COMMAND" | sha256sum | cut -d' ' -f1)
  FIFO="/tmp/pi-bash-perm-$HASH-$$.fifo"
  
  mkfifo "$FIFO"
  
  if read -t 30 decision < "$FIFO"; then
    rm -f "$FIFO"
    [[ "$decision" == "allow" ]] && exec "$REAL_BASH" "$@"
    exit 1
  else
    rm -f "$FIFO"
    echo "Timeout: denied" >&2
    exit 1
  fi
  ```

- [ ] **check-command.mjs** (Node.js helper)
  - Read `~/.config/pi/bash-permission.json`
  - Check exact matches first (allow/deny)
  - Check prefix matches second
  - Return: "allow" | "deny" | "unknown"

### Extension Updates

- [ ] Add FIFO polling to extension
  ```typescript
  const seenFifos = new Set<string>();
  
  setInterval(() => {
    const files = fs.readdirSync("/tmp");
    const fifos = files.filter(f => 
      f.startsWith("pi-bash-perm-") && f.endsWith(".fifo")
    );
    
    for (const fifo of fifos) {
      if (!seenFifos.has(fifo)) {
        seenFifos.add(fifo);
        handleFifo(`/tmp/${fifo}`);
      }
    }
  }, 100);
  ```

- [ ] Implement FIFO handler
  ```typescript
  async function handleFifo(fifoPath: string) {
    // Extract hash/PID from filename
    const match = fifoPath.match(/pi-bash-perm-([a-f0-9]+)-(\d+)\.fifo$/);
    if (!match) return;
    
    const [, hash, pid] = match;
    
    // Show UI
    const choice = await ctx.ui.select(
      `Allow command? (hash: ${hash.slice(0,16)}...)`,
      ["❌ Deny once", "✅ Allow once"]
    );
    
    // Write decision
    const decision = choice?.includes("Allow") ? "allow" : "deny";
    try {
      fs.writeFileSync(fifoPath, decision + "\n");
    } catch (err) {
      // FIFO might be gone (timeout)
    }
  }
  ```

- [ ] Add stale FIFO cleanup on startup
  - Check if PID exists: `kill -0 $PID 2>/dev/null`
  - Remove FIFOs where PID is dead

### Integration

- [ ] Package wrapper + helper in Nix
  - Use `writeShellScript` for wrapper
  - Patch shebangs for Node.js helper
  - Install to `$out/bin/bash-permission-wrapper`
  - Install helper to `$out/libexec/bash-permission/check-command.mjs`

- [ ] Make pi use wrapper (SOLVED ✅)
  - User sets `shellPath` in `~/.pi/agent/settings.json`:
    ```json
    {
      "shellPath": "/nix/store/.../bin/bash-permission-wrapper"
    }
    ```
  - Or: create a pi wrapper script that sets it automatically
  - **Easiest**: User runs post-install command that updates settings.json

- [ ] Pass real bash path to wrapper
  - Wrapper detects: `REAL_BASH="${REAL_BASH:-$(command -v bash)}"`
  - Or: hardcode in Nix derivation via `substituteInPlace`
  - Extension installation can set REAL_BASH in settings.json wrapper script

### Testing

- [ ] Update integration tests
  - Verify denial now blocks (simulate extension writing to FIFO)
  - Test pre-configured rules (no FIFO created)
  - Test timeout (FIFO created, no response)

- [ ] Manual testing
  - Run pi with wrapper
  - Try dangerous commands, verify blocking works
  - Test concurrent requests

- [ ] Edge cases
  - Wrapper crashes → stale FIFO
  - Extension crashes → wrapper timeout
  - Multiple pi instances → PID prevents collisions

### Documentation

- [ ] Update README with wrapper installation
- [ ] Remove "In Progress" section when complete
- [ ] Document configuration options

## Completed

- ✅ Extension loads and intercepts bash commands
- ✅ Pre-configured rules work (exact/prefix, allow/deny)
- ✅ UI dialogs and config management
- ✅ 14 unit tests + 2 integration tests
- ✅ Dummy LLM provider for testing without network
- ✅ Diagnosed async blocking issue
