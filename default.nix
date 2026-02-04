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
            export HOME="$PWD"
            cp -r "${./extensions + "/${ext}"}" "$out"
            chmod +w -R "$out"
            patchShebangs "$out"
            cd "$out"
            ./test.sh
          '';
    };
    "${drv}/index.ts";
};
rec {
  all = pkgs.writeText "pi-all-extensions" (
    pkgs.lib.concatStringsSep "\n" (builtins.attrValues extensions)
  );

  extensions = builtins.mapAttrs (name: _: make-extension name) (
    builtins.readDir ./extensions
  );
}
