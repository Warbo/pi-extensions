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

    # Parse command from arguments (bash is called with -c "command")
    if [ "$#" -lt 2 ] || [ "$1" != "-c" ]; then
        echo "bash-permission: Not the expected format, denied" >&2
        exit 1
    fi
    COMMAND="$2"

    # Create FIFO for communication, based on hash of command
    HASH=$(printf '%s' "$COMMAND" | sha256sum | cut -d' ' -f1)
    FIFO="/tmp/pi-bash-perm-$HASH.fifo"
    if [ -e "$FIFO" ]; then
      sleep 0.1
      if [ -e "$FIFO" ]; then
        echo "bash-permission: FIFO collision, command denied '$COMMAND'" >&2
        exit 1
      fi
    fi
    mkfifo "$FIFO"
    trap "rm -f '$FIFO'" EXIT

    # Wait for response from extension (30 second timeout)
    if read -t 30 DECISION < "$FIFO"; then
      if [ "$DECISION" = "allow" ]; then
        rm -f "$FIFO"  # Exit trap won't run after exec
        exec "''${SHELL:-${pkgs.bash}/bin/bash}" -c "$COMMAND"
      else
        echo "bash-permission: Command denied '$COMMAND'" >&2
        exit 1
      fi
    else
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
