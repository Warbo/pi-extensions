# Bash Permission Extension

An interactive permission system for bash commands in pi. Requires confirmation before executing any bash command, with flexible options to remember decisions.

## Features

- 🔒 **Confirm all commands**: Every bash command requires explicit permission
- 💾 **Remember decisions**: Save allow/deny rules for future use
- 🎯 **Flexible matching**: Support both exact commands and prefix patterns
- 🚫 **Non-interactive safety**: Auto-deny unknown commands when no UI is available
- ⏱️ **Timeout protection**: Auto-deny if no response within timeout period
- 🛠️ **Easy management**: Built-in `/permissions` command to view and clear rules

## Installation

### Project-local

```bash
# Create extensions directory
mkdir -p .pi/extensions

# Symlink or copy the extension
ln -s /path/to/pi-extensions/extensions/bash-permission .pi/extensions/

# Start pi - extension loads automatically
pi
```

### Global

```bash
# Symlink to global extensions directory
ln -s /path/to/pi-extensions/extensions/bash-permission ~/.pi/agent/extensions/

# Extension will load in all pi sessions
pi
```

### One-off testing

```bash
pi -e /path/to/pi-extensions/extensions/bash-permission/index.ts
```

## Usage

Once installed, the extension will intercept all bash commands and prompt for confirmation:

```
🔒 Bash Permission Required

Command: ls -la

What would you like to do?

❌ Deny once         - Block this command, don't save
✅ Allow once        - Run this command, don't save
🚫 Deny prefix       - Block commands matching a prefix
✓ Allow exact        - Always allow this exact command
✓✓ Allow prefix      - Always allow commands matching a prefix
```

### Option Details

#### ❌ Deny once
Blocks the command without saving any rules. You'll be asked again if pi tries to run the same command later.

#### ✅ Allow once
Allows the command to run without saving any rules. You'll be asked again if pi tries to run the same command later.

#### 🚫 Deny prefix
Blocks the command and saves a prefix pattern. You'll be prompted to enter the prefix (defaults to the full command).

Example: If you deny prefix `rm -rf`, any command starting with `rm -rf` will be automatically blocked.

#### ✓ Allow exact
Allows the command to run and saves it as an allowed command (exact match only).

Example: If you allow exact `git status`, only exactly `git status` will be auto-allowed. `git status --short` will still require confirmation.

#### ✓✓ Allow prefix
Allows the command to run and saves a prefix pattern. You'll be prompted to enter the prefix (defaults to the full command).

Example: If you allow prefix `git `, all git commands will be auto-allowed.

### Managing Permissions

Use the `/permissions` command to manage your saved rules:

```
/permissions
```

This opens a menu with options to:
- 📋 View all rules - See all saved allow/deny patterns
- 🗑️ Clear all rules - Remove all saved rules (with confirmation)
- 📂 Open config file - Show the config file location

## Configuration

The extension stores its configuration in:

```
~/.config/pi/bash-permission.json
```

### Configuration Format

```json
{
  "allowedExact": [
    "ls",
    "git status",
    "pwd"
  ],
  "deniedExact": [
    "rm -rf /",
    "sudo rm -rf /"
  ],
  "allowedPrefixes": [
    "git ",
    "npm ",
    "echo "
  ],
  "deniedPrefixes": [
    "sudo rm",
    "dd if="
  ],
  "confirmTimeout": 30000
}
```

### Configuration Fields

- **allowedExact**: Array of commands that are always allowed (exact string match)
- **deniedExact**: Array of commands that are always blocked (exact string match)
- **allowedPrefixes**: Array of prefixes - commands starting with these are always allowed
- **deniedPrefixes**: Array of prefixes - commands starting with these are always blocked
- **confirmTimeout**: Milliseconds to wait for user response before auto-denying (default: 30000)

### Priority Order

When a command is checked, the extension evaluates rules in this order:

1. Exact deny - if command is in `deniedExact`, block immediately
2. Exact allow - if command is in `allowedExact`, allow immediately
3. Prefix deny - if command starts with any `deniedPrefixes`, block
4. Prefix allow - if command starts with any `allowedPrefixes`, allow
5. Unknown - prompt user for decision

## Non-Interactive Mode

When pi runs without a UI (print mode, JSON mode, or RPC mode), the extension:

- ✅ Allows commands that match saved allow rules
- ❌ Blocks commands that match saved deny rules
- ❌ Blocks unknown commands (for safety)

This means you should build up your allow list in interactive mode before using non-interactive features.

## Examples

### Example 1: Allow all git commands

When prompted for a git command:
1. Select "✓✓ Allow prefix"
2. Enter `git ` (with trailing space)
3. All future git commands will be auto-allowed

### Example 2: Deny all sudo commands

When prompted for a sudo command:
1. Select "🚫 Deny prefix"
2. Enter `sudo ` (with trailing space)
3. All future sudo commands will be auto-blocked

### Example 3: Allow specific npm scripts

For `npm run build`:
1. Select "✓ Allow exact"
2. This exact command is saved
3. `npm run test` will still need confirmation

### Example 4: Start with common safe commands

Edit `~/.config/pi/bash-permission.json`:

```json
{
  "allowedPrefixes": [
    "ls",
    "cat ",
    "echo ",
    "pwd",
    "git status",
    "git diff",
    "git log",
    "npm ",
    "node ",
    "python ",
    "grep "
  ],
  "deniedPrefixes": [
    "sudo rm",
    "rm -rf",
    "dd if=",
    "mkfs",
    "> /etc/"
  ],
  "confirmTimeout": 30000
}
```

## FAQ

### Why does it ask about every command?

This extension takes a security-first approach. Rather than trying to detect "dangerous" commands (which is error-prone), it requires explicit permission for all commands and lets you build an allow list.

### Can I pre-populate the allow list?

Yes! Edit `~/.config/pi/bash-permission.json` and add your commonly-used safe commands to `allowedPrefixes`.

### What if I make a mistake?

Use `/permissions` to view all rules, then edit the config file directly to remove unwanted rules. Or use "Clear all rules" to start fresh.

### Does this work with multi-line commands?

Yes, the extension sees the full command string, including newlines in multi-line commands.

### Does this work with piped commands?

Yes, pipes are part of the command string. For example, `ls | grep foo` is treated as one command.

### Can I disable the extension temporarily?

Yes, either:
1. Remove it from your extensions directory
2. Use `/reload` to reload pi without the extension
3. Or add all commands to the allow list for that session

## Troubleshooting

### Commands are always blocked in non-interactive mode

This is expected behavior. Build your allow list in interactive mode first, then non-interactive mode will use those saved rules.

### Config file not being saved

Check that `~/.config/pi` directory exists and is writable:

```bash
mkdir -p ~/.config/pi
chmod 755 ~/.config/pi
```

### Timeout too short/long

Edit `confirmTimeout` in the config file (value in milliseconds).

## Future Enhancements

Planned features (see [TODO.md](../../TODO.md)):

- 🤖 LLM-powered safety analysis (ask a weak model for command safety summary)
- 💡 LLM-suggested safer alternatives
- 📊 Audit log of all allowed/blocked commands
- 🔍 Dry-run mode to see what would be blocked without blocking
- 🎯 More sophisticated pattern matching (regex, globs)

## Contributing

See the main [README.md](../../README.md) for contribution guidelines.

## License

Public Domain - use freely, no attribution required.
