# Pi Extensions

`pkarr://4ysq1yefe7ozox8m3qzbjzk6a5b8ae36jhn8xd1hszyht8ka9b`

Extensions for [pi](https://github.com/badlogic/pi) coding agent.

## Available Extensions

- **[artemis](extensions/artemis/README.md)** - Git-based issue tracker integration for managing issues, tasks, and notes
- **[bash-permission](extensions/bash-permission/README.md)** - Prompts for confirmation before executing bash commands
- **[emacsclient](extensions/emacsclient/README.md)** - Interact with emacsclient; also replaces `read`/`write`
- **[ollama-react](extensions/ollama-react/README.md)** - Convert ReAct thinking and tool calls to Pi's format

## Installation

The `SYSTEM` prompt is optional, but requires building.

```bash
nix-build -A SYSTEM
```

The extensions don't *require* building, but it's recommended since it runs
their tests.

```bash
nix-build -A extensions.bash-permission
```

To build everything (e.g. for testing):

```bash
nix-build --no-out-link -A all
```

**WARNING** The tests are designed to be run by a Nix derivation which sandboxes
their execution. Running test scripts (especially integration tests) outside of
a sandbox might mess with your "real" system!

### Home Manager (recommended)

Those using Home Manager can generate dotfiles for Pi, which reference these Nix
definitions directly. For example:

```nix
with {
  # Or use fetchGit, fetchTarball, etc.
  piExtensions = import /path/to/this/repo { inherit pkgs; };
};
{
  home.file = {
    # Make extensions available to Pi
    ".pi/agent/settings.json".text = builtins.toJSON {
      extensions = builtins.attrValues
        # Load all extensions
        piExtensions.extensions;

        # Or just specific ones
        # {
        #   inherit (piExtensions.extensions)
        #     bash-permission
        #     ollama-react
        #   ;
        # };
    };

    # Use our system prompt
    ".pi/agent/SYSTEM.md".source = piExtensions.SYSTEM;
  };
}
```

Similar results can be achieved for NixOS, nix-darwin, etc.

### Manual (using Nix)

Use Nix to build the parts you want (perhaps combined using
[`buildEnv`](https://github.com/NixOS/nixpkgs/blob/master/pkgs/build-support/buildenv/default.nix)):

- Extensions can be added to your `settings.json` by referencing their output
path(s).
- The `SYSTEM` prompt can be enabled by symlinking `SYSTEM.md` to its output path.

Rather than hard-coding `/nix/store` paths directly, it is recommended to use
the `result` symlinks created by `nix-build`. This ensures changes and rebuilds
get picked up without further effort; and the presence of those symlinks avoids
having those paths garbage-collected.

### Manual (without Nix)

The `extensions/` subdirectories can be referenced directly in your
`settings.json`, e.g.

```
{
  "extensions": [
    "/path/to/this/repo/extensions/artemis",
    "/path/to/this/repo/extensions/bash-permission"
  ]
}
```

The `SYSTEM` prompt is mostly just string templates concatenated together, which
is easy enough to reproduce in your own `SYSTEM.md` file. We use Nix to extract
the `description` fields from our tools (so their `index.ts` files are a single
source of truth): you can achieve the same by manually copy/pasting them.

## License

Public domain
