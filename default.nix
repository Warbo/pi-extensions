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
with {
  testExtension = ext: ''
    cp -r ${./extensions}/${ext} "$out/extensions/"

    if [ -f "$out/extensions/${ext}/test-helper.mjs" ]; then
      patchShebangs "$out/extensions/${ext}/test-helper.mjs"
      chmod +x "$out/extensions/${ext}/test-helper.mjs"
    fi

    if [ -f "$out/extensions/${ext}/test-integration.mjs" ]; then
      patchShebangs "$out/extensions/${ext}/test-integration.mjs"
      chmod +x "$out/extensions/${ext}/test-integration.mjs"
    fi

    if [ -f "$out/extensions/${ext}/test-dummy-llm.ts" ]; then
      chmod +x "$out/extensions/${ext}/test-dummy-llm.ts"
    fi

    pushd "$out/extensions/${ext}"
    ${pkgs.writeShellScript "${ext}-test.sh" (
      builtins.readFile (./extensions + "/${ext}/test.sh")
    )}
    popd
  '';
};
pkgs.runCommand "pi-extensions"
  {
    buildInputs = with pkgs; [
      nodejs_20
      nodePackages.typescript
      llm-agents.pi
    ];
  }
  ''
    mkdir -p "$out/extensions"
    cp ${./README.md} "$out/"
    cp ${./LICENSE} "$out/"
    ${pkgs.lib.concatMapStringsSep "\n" testExtension [ "bash-permission" ]}
  ''
