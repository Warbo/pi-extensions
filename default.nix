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
};
rec {
  bash-permission-wrapper = pkgs.writeShellScript "bash-permission-wrapper" ''
    # TODO: Implement FIFO-based permission checking, only proceed if approved
    exec "''${SHELL:-${pkgs.bash}/bin/bash}" "$@"
  '';

  all = pkgs.writeText "pi-all-extensions" (
    pkgs.lib.concatStringsSep "\n" (builtins.attrValues extensions)
  );

  extensions = builtins.mapAttrs (name: _: make-extension name) (
    builtins.readDir ./extensions
  );
}
