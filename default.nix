with {
  inherit (builtins)
    convertHash
    getEnv
    ;
};
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
  artemis ? import (fetchGitIPFS {
    sha1 = "6ea8036e6c04b73aff045acd0a5c195846454561";
  }) { },
  fetchGitIPFS ? (
    with rec {
      # The version of fetchGitIPFS.nix. Shouldn't need updating often.
      hash = "sha256-Cd+/MvPeFksqi4uZ9SaeHEIHKQH0UJTcl6w65TIw3WA=";
      cid = "f01551220${
        convertHash {
          inherit hash;
          hashAlgo = "sha256";
          toHashFormat = "base16";
        }
      }";

      # fetchurl only takes one URL, so allow it to be overridden by env var.
      override = getEnv "IPFS_GATEWAY";
      gateway = if override == "" then "https://ipfs.io" else override;
    };
    import (
      import <nix/fetchurl.nix> {
        inherit hash;
        url = "${gateway}/ipfs/${cid}";
      }
    )
  ),
}:
with rec {
  make-extension =
    ext:
    pkgs.runCommand "pi-extension-${ext}"
      {
        buildInputs = [
          artemis
          pkgs.nodejs_20
          pkgs.nodePackages.typescript
          pkgs.llm-agents.pi
          pkgs.git
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
rec {
  all = pkgs.writeText "pi-all-extensions" (
    pkgs.lib.concatStringsSep "\n" (builtins.attrValues extensions)
  );

  extensions = builtins.mapAttrs (name: _: make-extension name) (
    builtins.readDir ./extensions
  );
}
