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

    # Create FIFO for communication, based on hash of command
    HASH=$(printf '%s' "$COMMAND" | sha256sum | cut -d' ' -f1)
    FIFO="$TEMP_DIR/pi-bash-perm-$HASH.fifo"
    log "FIFO path: $FIFO"
    log "Hash: $HASH"

    if [ -e "$FIFO" ]; then
      log "FIFO already exists, waiting..."
      sleep 0.1
      if [ -e "$FIFO" ]; then
        log "ERROR: FIFO collision"
        echo "bash-permission: FIFO collision, command denied '$COMMAND'" >&2
        exit 1
      fi
    fi

    mkfifo "$FIFO"
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
