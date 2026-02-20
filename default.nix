with {
  inherit (builtins)
    attrValues
    convertHash
    getEnv
    mapAttrs
    readDir
    ;
};
{
  artemis ? warbo-packages.artemis,
  pi ? warbo-packages.pi,
  pkgs ? warbo-packages.nix-helpers.nixpkgs,
  warbo-packages ? import (fetchGitIPFS {
    sha1 = "46e129fc24ef78f2a389f6aa816f30ad4bbfec5c";
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
          pi
          pkgs.git
          pkgs.nodePackages.typescript
          pkgs.nodejs_20
          pkgs.tsx
          (pkgs.emacsPackages.emacsWithPackages (
            es:
            builtins.attrValues {
              inherit (es.treesit-grammars) with-all-grammars;
            }
          ))
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
    pkgs.lib.concatMapStringsSep "\n" (e: "${e}") (attrValues extensions)
  );

  extensions = mapAttrs (name: _: make-extension name) (readDir ./extensions);

  SYSTEM = pkgs.callPackage ./SYSTEM.nix { inherit pi; };
}
