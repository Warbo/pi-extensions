# Wrapper Script Architecture

## Problem

Pi's extension events are asynchronous. When a `tool_call` handler calls `await ctx.ui.select()`, tool execution begins immediately without waiting for the handler to complete. Therefore, returning `{ block: true }` happens too late to prevent execution.

## Solution: Bash Wrapper + FIFO Coordination

Replace pi's bash binary with a wrapper script that:
1. Checks pre-configured allow/deny rules (fast path)
2. For unknown commands, creates a FIFO (named pipe) and blocks reading from it
3. Extension polls for FIFO, shows UI, writes decision to FIFO
4. Wrapper reads decision and executes or denies

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                         Pi Process                          │
│                                                             │
│  ┌──────────┐         ┌──────────────┐                     │
│  │   LLM    │────────>│  Extension   │                     │
│  │  Model   │         │  (monitors   │                     │
│  └──────────┘         │   tempdir)   │                     │
│       │               └───────┬──────┘                     │
│       │                       │                            │
│       v                       │ writes "allow"/"deny"      │
│  "Execute bash"               v                            │
│       │              /tmp/pi-bash-perm-{hash}-{pid}.fifo   │
│       v                       ^                            │
│  ┌──────────────────────────────────────────────┐          │
│  │         Bash Wrapper Script                  │          │
│  │  1. Check config (pre-allowed/denied?)       │          │
│  │  2. If unknown: create FIFO                  │          │
│  │  3. Read from FIFO (blocks)                  │          │
│  │  4. Execute real bash OR deny                │          │
│  └──────────────────────────────────────────────┘          │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## FIFO Protocol

### Naming Convention

```
/tmp/pi-bash-perm-{SHA256}-{PID}.fifo
```

Where:
- `SHA256` = hex digest of exact command string
- `PID` = wrapper's process ID
- Temp dir: `$TMPDIR` → `$TEMP` → `$TMP` → `/tmp`

### Communication Flow

**Wrapper**:
1. Create FIFO: `mkfifo /tmp/pi-bash-perm-{hash}-{pid}.fifo`
2. Open for reading (blocks until writer appears)
3. Read decision: "allow" or "deny"
4. Clean up FIFO
5. Execute or deny based on decision

**Extension**:
1. Poll for FIFO existence (100ms interval, max 1 second)
2. When found, read hash from filename
3. Show UI dialog to user
4. Write decision to FIFO: `echo "allow" > fifo` or `echo "deny" > fifo`

### Timeout Handling

Reading from FIFO with timeout:
```bash
read -t 30 decision < "$FIFO" || decision="timeout"
```

If timeout occurs (30 seconds), deny by default for safety.

## Sequence Diagrams

### Pre-Allowed Command (Fast Path)

```
Pi → Wrapper: Execute "ls -la"
Wrapper → Config: Check rules
Config → Wrapper: Allowed (exact match)
Wrapper → Real Bash: exec "ls -la"
Real Bash → Pi: [output]
```

No FIFO created, no extension involvement.

### Unknown Command (Full Flow)

```
Pi → Wrapper: Execute "git push"
Wrapper → SHA256: hash("git push") = abc123...
Wrapper → FIFO: mkfifo /tmp/pi-bash-perm-abc123-12345.fifo
Wrapper → FIFO: read -t 30 decision < fifo (BLOCKS)

Extension → [polling]: Check for new FIFOs
Extension → FIFO: Found /tmp/pi-bash-perm-abc123-12345.fifo
Extension → User: Show dialog "Allow 'git push'?"
User → Extension: Click "✅ Allow once"
Extension → FIFO: echo "allow" > fifo

Wrapper → FIFO: Unblocks, decision = "allow"
Wrapper → FIFO: rm fifo
Wrapper → Real Bash: exec "git push"
Real Bash → Pi: [output]
```

### Denial Flow

```
Pi → Wrapper: Execute "rm important.txt"
Wrapper → FIFO: Create and block on read

Extension → User: Show dialog
User → Extension: Click "❌ Deny once"
Extension → FIFO: echo "deny" > fifo

Wrapper → FIFO: Unblocks, decision = "deny"
Wrapper → FIFO: rm fifo
Wrapper → Pi: Exit 1 with error message
```

### Timeout Scenario

```
Pi → Wrapper: Execute "curl suspicious-url.com"
Wrapper → FIFO: Create and block with 30s timeout
... (30 seconds pass, no extension response) ...
Wrapper → FIFO: read timeout, decision = "timeout"
Wrapper → FIFO: rm fifo
Wrapper → Pi: Exit 1 "Timeout: denied by default"
```

## Implementation Details

### Wrapper Script (bash-wrapper.sh)

```bash
#!/usr/bin/env bash
set -euo pipefail

REAL_BASH="${REAL_BASH:-/usr/bin/bash}"
CONFIG_FILE="$HOME/.config/pi/bash-permission.json"
TEMP_DIR="${TMPDIR:-${TEMP:-${TMP:-/tmp}}}"
TIMEOUT_SECONDS=30

# Extract command (usually: bash -c "command string")
if [[ "$1" == "-c" ]]; then
    COMMAND="$2"
else
    # Other bash invocation modes: pass through
    exec "$REAL_BASH" "$@"
fi

# Check config (using Node.js helper)
DECISION=$(node "$(dirname "$0")/check-command.mjs" "$CONFIG_FILE" "$COMMAND")

if [[ "$DECISION" == "allow" ]]; then
    exec "$REAL_BASH" "$@"
elif [[ "$DECISION" == "deny" ]]; then
    echo "Command denied by saved rule: $COMMAND" >&2
    exit 1
fi

# Unknown command: create FIFO and wait for extension
HASH=$(echo -n "$COMMAND" | sha256sum | cut -d' ' -f1)
PID=$$
FIFO="$TEMP_DIR/pi-bash-perm-$HASH-$PID.fifo"

mkfifo "$FIFO"

# Read with timeout (blocks until extension writes)
if read -t "$TIMEOUT_SECONDS" decision < "$FIFO"; then
    rm -f "$FIFO"
    
    if [[ "$decision" == "allow" ]]; then
        exec "$REAL_BASH" "$@"
    else
        echo "Command denied by user: $COMMAND" >&2
        exit 1
    fi
else
    # Timeout
    rm -f "$FIFO"
    echo "Timeout: command denied by default: $COMMAND" >&2
    exit 1
fi
```

### Extension Monitoring (TypeScript)

```typescript
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

const TEMP_DIR = process.env.TMPDIR || process.env.TEMP || process.env.TMP || "/tmp";
const FIFO_PREFIX = "pi-bash-perm-";
const FIFO_SUFFIX = ".fifo";

function hashCommand(command: string): string {
    return crypto.createHash("sha256").update(command, "utf8").digest("hex");
}

// Poll for new FIFOs every 100ms
function startMonitoring(ctx: any) {
    const seenFifos = new Set<string>();
    
    setInterval(() => {
        try {
            const files = fs.readdirSync(TEMP_DIR);
            const fifos = files.filter(f => 
                f.startsWith(FIFO_PREFIX) && f.endsWith(FIFO_SUFFIX)
            );
            
            for (const fifo of fifos) {
                const fifoPath = path.join(TEMP_DIR, fifo);
                
                if (seenFifos.has(fifoPath)) continue;
                seenFifos.add(fifoPath);
                
                // Process in background
                handleFifo(fifoPath, ctx).catch(err => {
                    console.error("Error handling FIFO:", err);
                });
            }
        } catch (error) {
            // Temp dir might not exist yet
        }
    }, 100);
}

async function handleFifo(fifoPath: string, ctx: any) {
    // Extract hash and PID from filename
    const filename = path.basename(fifoPath);
    const match = filename.match(/^pi-bash-perm-([0-9a-f]+)-(\d+)\.fifo$/);
    if (!match) return;
    
    const [, hash, pid] = match;
    
    // We don't have the original command, but we can show the hash
    // Or: implement reverse lookup if we track commands
    // For now, show generic message
    
    const choice = await ctx.ui.select(
        `🔒 Bash Permission Required\n\nCommand hash: ${hash.substring(0, 16)}...\nPID: ${pid}\n\nWhat would you like to do?`,
        ["❌ Deny once", "✅ Allow once"],
        { timeout: 30000 }
    );
    
    const decision = choice?.includes("Allow") ? "allow" : "deny";
    
    // Write decision to FIFO
    try {
        fs.writeFileSync(fifoPath, decision + "\n");
    } catch (error) {
        // FIFO might be gone (timeout)
    }
}
```

## Security Considerations

### Race Conditions

**Scenario**: Extension finds FIFO before fully created  
**Mitigation**: FIFO creation is atomic (`mkfifo`), writing will block until wrapper opens for reading

**Scenario**: Multiple extensions/processes try to write  
**Mitigation**: First write wins, wrapper only reads once. PID in filename prevents collisions.

### Spoofing

**Risk**: Attacker creates fake FIFO with predictable name  
**Mitigation**: 
- PID is unpredictable to external observer
- SHA256 hash space is large
- Attacker with same UID can already execute arbitrary commands

### Cleanup

**Scenario**: Wrapper crashes before removing FIFO  
**Mitigation**: Extension periodically cleans stale FIFOs (check if PID exists)

**Scenario**: Extension crashes, never writes decision  
**Mitigation**: Wrapper timeout (30s) cleans up FIFO and denies

## Advantages Over Request/Response Files

1. **Simpler**: One file instead of two
2. **Synchronous**: Wrapper blocks automatically (no polling loop)
3. **Built-in timeout**: `read -t` handles timeout cleanly
4. **Atomic**: Writing to FIFO is naturally atomic
5. **Self-cleaning**: FIFOs disappear when both ends close

## Implementation Phases

### Phase 1: Wrapper Script
- Create `bash-wrapper.sh` with config checking
- Implement FIFO creation and blocking read
- Create `check-command.mjs` helper for config

### Phase 2: Extension Monitoring
- Add FIFO polling to extension
- Implement decision writing
- Add stale FIFO cleanup

### Phase 3: Integration
- Configure pi to use wrapper (PATH manipulation or tool override)
- Test end-to-end flow
- Handle edge cases

### Phase 4: Testing
- Update integration tests to verify blocking works
- Test concurrent requests
- Test timeout scenarios
