# Bash Permission Extension

Prompts for confirmation before pi executes bash commands.

## Installation

```nix
let
  piExtensions = import /path/to/repo { inherit pkgs; };
in {
  home.file.".pi/agent/settings.json".text = builtins.toJSON {
    extensions = [ piExtensions.extensions.bash-permission ];
  };
}
```

Or just copy to your extensions directory:
```bash
cp extensions/bash-permission/index.ts ~/.pi/agent/extensions/
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
  "allowedExact": ["ls -la", "git status"],
  "deniedExact": ["rm -rf /"],
  "allowedPrefixes": ["git "],
  "deniedPrefixes": ["rm -rf", "sudo "]
}
```

**Priority**: exact deny > exact allow > prefix deny > prefix allow
