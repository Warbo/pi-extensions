# TODO

## Current Status

### What Works ✅
- Extension correctly intercepts bash tool calls
- Extension shows permission dialog UI
- Wrapper is invoked by pi (shellPath settings work correctly)
- Pi sends tool_execution_end for bash commands with non-zero exit codes
- FIFO-based IPC architecture is fundamentally sound
- **FIXED: FIFO path matching between extension and wrapper**
  - Wrapper now finds pi's PID by walking process tree
  - Both extension and wrapper use: `/tmp/pi-bash-perm-<pi_pid>-<hash>.fifo`
  - FIFO paths now match correctly ✅

### Known Issues (Need Testing)
- **Potential: FIFO collisions when pi retries commands**
  - If pi retries the same command with same PID, same FIFO path will be used
  - Need to test if this actually happens in practice
  - Current implementation includes basic collision detection (checks if FIFO exists, waits 100ms)

## Next Steps

### Test the Fix
1. **Run the test suite** to verify FIFO path matching works
   ```bash
   cd extensions/bash-permission
   ./test.sh
   ```

2. **Verify FIFO cleanup** by checking logs:
   ```bash
   grep "FIFO cleanup" /tmp/bash-permission-wrapper-*.log
   ```

3. **Check for collision issues**:
   - Monitor if retries still cause problems
   - Check logs for "FIFO collision" errors
   - Verify trap cleanup is working properly

### If Collisions Still Occur (Future Work)

Possible approaches if retries become an issue:
1. **Include retry counter**: Add sequence number to FIFO path
2. **Reuse FIFO on retry**: Check if FIFO exists and is still valid before erroring
3. **Timeout-based cleanup**: Short-lived FIFOs that auto-expire
4. **Block-and-wait**: Second attempt waits for first to complete instead of erroring

## Architecture Overview

The bash permission system uses a FIFO-based IPC mechanism:

1. **User configures** `shellPath` in `.pi/settings.json` to point to wrapper
2. **Wrapper intercepts** bash commands:
   - Walks process tree from `$PPID` to find pi's PID (checks for `node` process running `pi`)
   - Hashes command: `sha256(command)` → hash
   - Creates FIFO: `${TMPDIR}/pi-bash-perm-<pi_pid>-<hash>.fifo`
   - Blocks reading from FIFO (30s timeout)
3. **Extension receives** `tool_call` event:
   - Gets pi's PID: `process.pid`
   - Shows permission dialog to user
   - Computes FIFO path: `${TMPDIR}/pi-bash-perm-<pi_pid>-<hash>.fifo`
   - Polls for FIFO to exist (10s timeout, 100ms intervals)
   - Writes "allow" or "deny" to FIFO
4. **Wrapper unblocks** and either:
   - Executes command (if "allow")
   - Exits with error (if "deny" or timeout)

### Why Pi's PID Works
- Pi's PID is stable for the lifetime of the pi process
- Extension knows it directly (`process.pid`)
- Wrapper can discover it by walking the process tree
- Both calculate the same FIFO path independently
- Avoids the previous mismatch where extension used pi's PID but wrapper used its own PID
