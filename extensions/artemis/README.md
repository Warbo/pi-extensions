# Artemis Extension

A pi extension that integrates the [artemis](https://github.com/dspinellis/git-issue) git-based issue tracker, allowing the LLM to manage issues, tasks, and notes directly within your repository.

## Overview

The artemis extension provides a `git_artemis` tool that wraps the `git artemis` command, enabling the LLM to:

- **Track issues**: Create and manage issues as the LLM discovers problems
- **Log information**: Document findings about known issues
- **Manage tasks**: Find and track TODOs directly in the repository
- **Update status**: Close or update issue properties as work progresses

## Prerequisites

You need `git-artemis` (or `git-issue`) installed on your system:

```bash
# Install git-issue (provides git-artemis)
# Via package manager or from https://github.com/dspinellis/git-issue
```

Initialize artemis in your repository:

```bash
cd your-repo
git artemis list  # This will initialize .issues/ directory
```

## Installation

### Using Nix + Home Manager

```nix
let
  piExtensions = import /path/to/this/repo { inherit pkgs; };
in {
  home.file.".pi/agent/settings.json".text = builtins.toJSON {
    extensions = [ piExtensions.extensions.artemis ];
  };
}
```

### Manual Installation

Copy `extensions/artemis/index.ts` to one of these locations:

- `~/.pi/agent/extensions/artemis.ts` (global)
- `.pi/extensions/artemis.ts` (project-local)

Or load it temporarily:

```bash
pi -e /path/to/extensions/artemis/index.ts
```

## Usage

The extension provides a single tool: `git_artemis`

### Actions

#### List Issues

```
List all open issues:
git_artemis(action="list")

List all issues (including closed):
git_artemis(action="list", all=true)

Filter by property:
git_artemis(action="list", property="state=new")

List available values for a property:
git_artemis(action="list", property="state")

Order by latest activity:
git_artemis(action="list", order="latest")
```

#### Create Issue

```
Create a new issue:
git_artemis(
    action="add",
    message="Memory leak in worker process",
    comment="Observed when processing large files. Need to investigate buffer management."
)

Create with properties:
git_artemis(
    action="add",
    message="Refactor authentication module",
    properties=["priority=high", "type=refactor"]
)
```

#### Show Issue

```
View full issue details:
git_artemis(action="show", issueId="abc1234")
```

#### Update Properties

```
Close an issue:
git_artemis(
    action="update",
    issueId="abc1234",
    properties=["state=resolved", "resolution=fixed"]
)

Update with custom comment (via separate git artemis command):
# First update properties
git_artemis(
    action="update",
    issueId="abc1234",
    properties=["priority=high"],
    noPropertyComment=true
)
# Note: Adding custom comments requires interactive editor
```

## Example Workflows

### Problem Discovery

When the LLM finds an issue during code review:

```
User: "Review the authentication code for security issues"

LLM: [uses git_artemis to create issue]
"I found a potential SQL injection vulnerability. I've logged it as issue abc1234."
```

### Task Management

Finding work to do:

```
User: "What issues need attention?"

LLM: [uses git_artemis(action="list", property="state=new")]
"There are 3 open issues:
1. abc1234 - SQL injection in auth
2. def5678 - Memory leak in worker
3. ghi9012 - Refactor config loading"
```

### Closing Issues

After fixing a problem:

```
User: "I've fixed the memory leak"

LLM: [uses git_artemis to close issue]
"Great! I've closed issue def5678 and marked it as resolved/fixed."
```

## Tips

1. **Be specific**: Provide detailed descriptions when creating issues
2. **Use properties**: Leverage properties like `priority`, `type`, `state` for organization
3. **Check first**: Use `list` to see existing issues before creating duplicates
4. **Reference commits**: Include commit hashes when fixing issues

## Properties

Common artemis properties (customizable per repo):

- `state`: new, assigned, resolved, closed, etc.
- `resolution`: fixed, wontfix, duplicate, etc.
- `priority`: low, normal, high, critical
- `type`: bug, feature, refactor, documentation
- `assigned`: username or email

To see available values for any property:
```
git_artemis(action="list", property="state")
```

## Rendering

The extension provides custom TUI rendering:

- **Compact view**: Shows first 10 issues/lines
- **Expanded view** (Ctrl+O): Shows full output
- **Syntax highlighting**: Issue IDs highlighted in listings
- **Status indicators**: ✓ for success, ✗ for errors

## Limitations

- Cannot add comments to existing issues via CLI (artemis requires interactive editor)
- Cannot handle binary attachments
- No support for filters (`.issues/.filter*` files)
- Requires a git repository with artemis initialized

## Troubleshooting

### "Not a git repository"

Make sure you're in a git repository with artemis initialized:

```bash
git artemis list
```

### "Command not found"

Install git-issue/git-artemis:

```bash
# Check if installed
which git-artemis
```

### "No issues found"

This is normal for a fresh repository. Create your first issue:

```
git_artemis(
    action="add",
    message="First issue"
)
```

## See Also

- [git-issue documentation](https://github.com/dspinellis/git-issue)
- [pi documentation](https://github.com/badlogic/pi)
- [Extension development guide](https://github.com/badlogic/pi/blob/main/docs/extensions.md)
