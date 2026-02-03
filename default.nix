{
  pkgs ? import <nixpkgs> {
    overlays =
      with {
        overlays = import /home/chris/Code/nix-config/overlays.nix;
      }; [
        overlays.nix-helpers
        overlays.numtide-llms
      ];
  },
}:
with rec {
  make-extension =
    ext:
    with {
      drv =
        pkgs.runCommand "pi-extension-${ext}"
          {
            inherit bashPermissionWrapper;
            buildInputs = with pkgs; [
              nodejs_20
              nodePackages.typescript
              llm-agents.pi
            ];
          }
          ''
            export HOME="$PWD"
            cp -r "${./extensions}/${ext}" "$out"
            chmod +w -R "$out"
            patchShebangs "$out"
            cd "$out"
            ./test.sh
          '';
    };
    "${drv}/index.ts";

  bashPermissionWrapper = pkgs.writeShellScript "bashPermissionWrapper" ''
    export PATH="$PATH:${pkgs.coreutils}/bin"

    # Use standard temp directory (respect TMPDIR, fall back to /tmp)
    TEMP_DIR="''${TMPDIR:-/tmp}"

    # Debug logging to file
    LOG_FILE="$TEMP_DIR/bash-permission-wrapper-$$.log"
    exec 3>>"$LOG_FILE"
    log() {
      echo "[$(date +%s.%N)] [$$] $*" >&3
    }

    log "Invoked with args: $@"

    # Parse command from arguments (bash is called with -c "command")
    if [ "$#" -lt 2 ] || [ "$1" != "-c" ]; then
        log "ERROR: Not the expected format"
        echo "bash-permission: Not the expected format, denied" >&2
        exit 1
    fi
    COMMAND="$2"
    log "Command: $COMMAND"

    log "Using temp dir: $TEMP_DIR"

    # Find pi's PID by traversing process tree
    find_pi_pid() {
      local pid=$PPID
      log "Starting process tree walk from PPID=$pid"
      
      while [ "$pid" != "1" ] && [ "$pid" != "0" ]; do
        # Check if this process exists
        if [ ! -d "/proc/$pid" ]; then
          log "Process $pid does not exist, stopping search"
          break
        fi
        
        # Get process name and command line
        local comm=$(cat /proc/$pid/comm 2>/dev/null || echo "")
        local cmdline=$(tr '\0' ' ' < /proc/$pid/cmdline 2>/dev/null || echo "")
        
        log "Checking PID $pid: comm='$comm', cmdline='$cmdline'"
        
        # Check if this is a node process running pi
        if [ "$comm" = "node" ]; then
          log "Found node process at PID $pid"
          # Check if it's running pi
          if echo "$cmdline" | grep -q "pi"; then
            log "Found pi process at PID $pid"
            echo "$pid"
            return 0
          fi
        fi
        
        # Move to parent process
        local parent_pid=$(cut -d' ' -f4 /proc/$pid/stat 2>/dev/null || echo "1")
        log "Moving to parent PID $parent_pid"
        pid=$parent_pid
      done
      
      # Fallback: couldn't find pi, use wrapper's PID
      log "WARNING: Could not find pi process, falling back to wrapper PID $$"
      echo "$$"
    }

    PI_PID=$(find_pi_pid)
    log "Using pi PID: $PI_PID"

    # Create FIFO name with pi's PID and command hash
    HASH=$(printf '%s' "$COMMAND" | sha256sum | cut -d' ' -f1)
    FIFO="$TEMP_DIR/pi-bash-perm-$PI_PID-$HASH.fifo"
    log "FIFO path: $FIFO"
    log "Hash: $HASH"

    # Create FIFO - check if it already exists (retry scenario)
    if [ -e "$FIFO" ]; then
      log "FIFO already exists, waiting for it to be ready..."
      # Wait a bit for the previous operation to complete
      sleep 0.1
      if [ -e "$FIFO" ]; then
        log "ERROR: FIFO still exists after wait, collision detected"
        echo "bash-permission: FIFO collision, command denied '$COMMAND'" >&2
        exit 1
      fi
    fi

    if ! mkfifo "$FIFO" 2>/dev/null; then
      log "ERROR: Failed to create FIFO"
      echo "bash-permission: Failed to create FIFO, command denied '$COMMAND'" >&2
      exit 1
    fi
    log "FIFO created successfully"
    trap "rm -f '$FIFO'; log 'FIFO cleanup'" EXIT

    # Wait for response from extension (30 second timeout)
    log "Waiting for decision (30s timeout)..."
    if read -t 30 DECISION < "$FIFO"; then
      log "Got decision: $DECISION"
      if [ "$DECISION" = "allow" ]; then
        log "Allowing command"
        rm -f "$FIFO"  # Exit trap won't run after exec
        exec "''${SHELL:-${pkgs.bash}/bin/bash}" -c "$COMMAND"
      else
        log "Denying command"
        echo "bash-permission: Command denied '$COMMAND'" >&2
        exit 1
      fi
    else
      log "ERROR: Timeout waiting for decision"
      echo "bash-permission: Timed out, command denied '$COMMAND'" >&2
      exit 1
    fi
  '';
};
rec {
  inherit bashPermissionWrapper;

  all = pkgs.writeText "pi-all-extensions" (
    pkgs.lib.concatStringsSep "\n" (builtins.attrValues extensions)
  );

  extensions = builtins.mapAttrs (name: _: make-extension name) (
    builtins.readDir ./extensions
  );
}
