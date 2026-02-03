# Pi Extensions

Extensions for [pi](https://github.com/badlogic/pi) coding agent.

## Available Extensions

- **[bash-permission](extensions/bash-permission/README.md)** - Prompts for confirmation before executing bash commands

## Installation (Nix + Home Manager)

```nix
let
  piExtensions = import /path/to/this/repo { inherit pkgs; };
in {
  home.file.".pi/agent/settings.json".text = builtins.toJSON {
    # Use the bash permission wrapper
    shellPath = piExtensions.bash-permission-wrapper;
    
    # Load extensions (pick which ones you want)
    extensions = builtins.attrValues piExtensions.extensions;
    # Or just specific ones:
    # extensions = [ piExtensions.extensions.bash-permission ];
  };
}
```

## Development

```bash
# Test everything
nix-build

# Build just the wrapper
nix-build -A bash-permission-wrapper
```

## License

MIT
