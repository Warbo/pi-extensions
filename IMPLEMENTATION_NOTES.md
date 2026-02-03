# Implementation Notes: Wrapper with FIFO

## Quick Reference

### FIFO Protocol

**Wrapper creates**: `/tmp/pi-bash-perm-{SHA256}-{PID}.fifo`

**Wrapper blocks**: `read -t 30 decision < "$FIFO"`

**Extension writes**: `echo "allow" > "$FIFO"` or `echo "deny" > "$FIFO"`

### Why FIFO Works

1. **Synchronous blocking**: `read` blocks until extension writes
2. **Built-in timeout**: `read -t 30` handles timeout automatically
3. **Simple**: One file instead of request + response files
4. **Self-cleaning**: FIFO disappears when both ends close
5. **Atomic**: Writing to FIFO is naturally atomic

### Key Advantage Over Two-File Approach

**Two files**: Wrapper must poll for response file (busy-wait loop)
```bash
for ((i=0; i<300; i++)); do
    if [[ -f "$RESPONSE_FILE" ]]; then
        # found it!
    fi
    sleep 0.1  # wasted CPU cycles
done
```

**FIFO**: Wrapper blocks in kernel, zero CPU until extension writes
```bash
read -t 30 decision < "$FIFO"  # blocks efficiently, no polling
```

## Implementation Checklist

### Phase 1: Wrapper

- [ ] Create `bash-wrapper.sh`
- [ ] Create `check-command.mjs` (config checker)
- [ ] Test SHA256 calculation matches between bash and Node.js
- [ ] Test FIFO creation and reading with timeout
- [ ] Handle edge cases (no FIFO, timeout, invalid decision)

### Phase 2: Extension

- [ ] Add FIFO polling to extension (check temp dir every 100ms)
- [ ] Parse FIFO filename to extract hash/PID
- [ ] Show UI dialog when FIFO detected
- [ ] Write decision to FIFO
- [ ] Add cleanup for stale FIFOs

### Phase 3: Integration

- [ ] Determine how to make pi use wrapper (PATH? symlink? config?)
- [ ] Test end-to-end flow
- [ ] Update integration tests to verify blocking works
- [ ] Test concurrent requests (multiple FIFOs)

## Common Patterns

### Wrapper: Create FIFO and read with timeout

```bash
HASH=$(echo -n "$COMMAND" | sha256sum | cut -d' ' -f1)
FIFO="/tmp/pi-bash-perm-$HASH-$$.fifo"

mkfifo "$FIFO"

if read -t 30 decision < "$FIFO"; then
    rm -f "$FIFO"
    [[ "$decision" == "allow" ]] && exec /usr/bin/bash "$@"
    exit 1
else
    # Timeout
    rm -f "$FIFO"
    exit 1
fi
```

### Extension: Poll for FIFOs and write decision

```typescript
setInterval(() => {
    const files = fs.readdirSync(TEMP_DIR);
    const fifos = files.filter(f => 
        f.startsWith("pi-bash-perm-") && f.endsWith(".fifo")
    );
    
    for (const fifo of fifos) {
        if (!seen.has(fifo)) {
            seen.add(fifo);
            handleFifo(path.join(TEMP_DIR, fifo));
        }
    }
}, 100);

async function handleFifo(fifoPath: string) {
    const choice = await ctx.ui.select("Allow?", ["yes", "no"]);
    const decision = choice === "yes" ? "allow" : "deny";
    fs.writeFileSync(fifoPath, decision + "\n");
}
```

## Testing Strategy

### Unit Tests

- Test config checker with various commands
- Test SHA256 calculation consistency
- Test FIFO creation/cleanup in isolation

### Integration Tests

- Create FIFO manually, write to it, verify wrapper unblocks
- Simulate wrapper by creating FIFO, verify extension detects it
- Test timeout by creating FIFO and never writing

### End-to-End Tests

- Run pi with wrapper, verify real commands are blocked/allowed
- Test with actual user interaction
- Test concurrent requests

## Potential Issues

### FIFO Doesn't Exist When Extension Checks

**Cause**: Wrapper creates FIFO just before blocking, small timing window

**Solution**: Extension polls multiple times (e.g., 10 times with 100ms interval = 1 second grace period)

### Extension Crashes Before Writing

**Cause**: Extension dies, FIFO never receives decision

**Solution**: Wrapper's `read -t 30` timeout handles this (denies by default)

### Multiple Extensions Try to Write

**Cause**: Multiple pi instances or extension instances

**Solution**: First write wins, wrapper only reads once. PID in filename prevents most collisions.

### Stale FIFOs

**Cause**: Wrapper crashes before cleanup

**Solution**: Extension checks if PID exists (`kill -0 $PID 2>/dev/null`), removes stale FIFOs

## Performance Considerations

**Pre-configured commands**: Zero overhead (no FIFO created)

**Unknown commands**: 
- FIFO creation: <1ms
- Kernel blocking: Zero CPU
- Extension polling: Minimal (checks every 100ms)
- User decision: 1-30 seconds (dominates)
- FIFO cleanup: <1ms

**Total overhead**: Negligible for interactive use

## Next Steps

See `TODO.md` Phase 2 for detailed task breakdown.

Start with:
1. Verify SHA256 calculation consistency
2. Test basic FIFO creation/reading
3. Implement wrapper skeleton
