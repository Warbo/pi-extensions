# Pi Extensions

`pkarr://4ysq1yefe7ozox8m3qzbjzk6a5b8ae36jhn8xd1hszyht8ka9b`

Extensions for [pi](https://github.com/badlogic/pi) coding agent.

## Available Extensions

- **[artemis](extensions/artemis/README.md)** - Git-based issue tracker integration for managing issues, tasks, and notes
- **[bash-permission](extensions/bash-permission/README.md)** - Prompts for confirmation before executing bash commands

## Installation (Nix + Home Manager)

```nix
let
  piExtensions = import /path/to/this/repo { inherit pkgs; };
in {
  home.file.".pi/agent/settings.json".text = builtins.toJSON {
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
