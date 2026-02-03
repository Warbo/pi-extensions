# Bash Permission Extension

Prompts for confirmation before pi executes bash commands.

## Installation

```nix
let
  piExtensions = import /path/to/repo { inherit pkgs; };
in {
  home.file.".pi/agent/settings.json".text = builtins.toJSON {
    shellPath = piExtensions.bash-permission-wrapper;
    extensions = [ piExtensions.extensions.bash-permission ];
  };
}
```

## Usage

When pi tries to execute a bash command:
- Pre-allowed → runs immediately
- Pre-denied → blocked immediately  
- Unknown → shows dialog:
  - **Allow once** / **Deny once**
  - **Always allow** / **Always deny** (saves to config)

View saved rules:
```
/permissions
```

## Configuration

Config: `~/.config/pi/bash-permission.json`

```json
{
  "rules": [
    {"command": "ls", "type": "exact", "action": "allow"},
    {"command": "rm", "type": "prefix", "action": "deny"}
  ]
}
```

**Types**: `exact` (matches exactly) or `prefix` (starts with)

**Priority**: exact deny > exact allow > prefix deny > prefix allow
