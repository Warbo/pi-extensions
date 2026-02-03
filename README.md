# Pi Extensions

A collection of extensions for the [pi coding agent](https://github.com/badlogic/pi-mono).

## Extensions

### Bash Permission

An interactive permission system for bash commands. Requires confirmation before executing any bash command, with flexible options to remember decisions.

**Status**: 🚧 In Development

**Features**:
- ✅ Require confirmation for all bash commands
- 🚧 Remember allowed/denied commands (exact match or prefix)
- 🚧 LLM-powered safety analysis and alternative suggestions
- 🚧 Non-interactive mode support (uses saved permissions only)

See [extensions/bash-permission/README.md](extensions/bash-permission/README.md) for details.

## Installation

### Project-local installation

```bash
# Clone this repository
git clone <repository-url> pi-extensions
cd pi-extensions

# Symlink to your project's extensions directory
mkdir -p .pi/extensions
ln -s $(pwd)/extensions/bash-permission .pi/extensions/

# Use pi in your project - extensions auto-load
pi
```

### Global installation

```bash
# Clone this repository
git clone <repository-url> ~/.pi/agent/extensions/pi-extensions
cd ~/.pi/agent/extensions/pi-extensions

# Symlink individual extensions
ln -s $(pwd)/extensions/bash-permission ~/.pi/agent/extensions/

# Extensions will load in all pi sessions
pi
```

### One-off testing

```bash
pi -e ./extensions/bash-permission/index.ts
```

## Requirements

- [pi](https://github.com/badlogic/pi-mono) v0.51.0 or later
- Node.js runtime (provided by pi)

## Development

### Using Nix (recommended)

```bash
# Enter development shell
nix-shell

# Or use direnv
echo "use nix" > .envrc
direnv allow
```

### Manual setup

```bash
# Install dependencies (if any extensions need them)
cd extensions/bash-permission
npm install
```

## Contributing

Contributions welcome! Please:

1. Follow the existing code style
2. Add tests for new features
3. Update documentation
4. Test with both interactive and non-interactive pi modes

## License

Public Domain. Use freely, no attribution required.

## Roadmap

See [TODO.md](TODO.md) for the full development roadmap.

Future extensions planned:
- File protection (block writes to sensitive files)
- Git safety (confirm force pushes, branch deletions)
- Network safety (confirm before exposing services)
- Resource monitoring (warn about resource-intensive commands)
