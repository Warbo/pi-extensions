# Artemis Extension

A pi extension that integrates the artemis git-based issue tracker, allowing the LLM to manage issues, tasks, and notes directly within your repository.

## Overview

The artemis extension provides a `git_artemis` tool that wraps the `git artemis` command, enabling the LLM to:

- **Track issues**: Create and manage issues as the LLM discovers problems
- **Log information**: Document findings about known issues
- **Manage tasks**: Find and track TODOs directly in the repository
- **Update status**: Close or update issue properties as work progresses

## Prerequisites

You need `git-artemis` installed on your system. This is provided by the `artemis` package (a Python-based git issue tracker).

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

The extension provides a single tool: `git_artemis` that wraps the git artemis CLI.

### Commands

#### List Issues (`git artemis list`)

Lists issues with `state=new` by default:

```
List new issues (default):
git_artemis(command="list")

List all issues:
git_artemis(command="list", all=true)
```

#### Create Issue (`git artemis add`)

Creates a new issue with subject and body:

```
git_artemis(
    command="add",
    subject="Memory leak in worker process",
    body="Observed when processing large files over 1GB. Memory usage grows unbounded and never gets freed."
)
```

#### Add Comment (`git artemis add <id>`)

Adds a comment to an existing issue. The subject line is left unchanged (inherited
from the original issue); only `commentBody` is required — do not pass `subject`:

```
git_artemis(
    command="add",
    issueId="abc1234",
    commentBody="Found the root cause - circular reference in cache invalidation"
)
```

#### Show Issue (`git artemis show <id>`)

Shows an issue (without comments):

```
git_artemis(command="show", issueId="abc1234")
```

#### Show Comment (`git artemis show <id> <n>`)

Shows a specific comment:

```
git_artemis(command="show", issueId="abc1234", commentNumber=0)
```

#### Close Issue (`git artemis add <id> -p state=resolved -p resolution=fixed`)

Closes an issue and adds a closing comment. `closeCommentBody` is required;
like all comments, the subject line is left unchanged:

```
git_artemis(
    command="close",
    issueId="abc1234",
    closeCommentBody="Fixed in commit abc1234 — circular reference removed"
)
```

## Example Workflows

### Problem Discovery

When the LLM finds an issue during code review:

```
User: "Review the authentication code for security issues"

LLM: [uses git_artemis(
    command="add",
    subject="SQL injection in auth module",
    body="Found potential SQL injection in user_login() function at line 42. User input is concatenated directly into query."
)]
"I found a potential SQL injection vulnerability. I've logged it as issue abc1234."
```

### Task Management

Finding work to do:

```
User: "What issues need attention?"

LLM: [uses git_artemis(command="list")]
"There are 3 open issues:
1. abc1234 - SQL injection in auth
2. def5678 - Memory leak in worker
3. ghi9012 - Refactor config loading"
```

### Adding Investigation Notes

Documenting findings on an issue:

```
User: "I found the cause of issue def5678"

LLM: [uses git_artemis(
    command="add",
    issueId="def5678",
    commentBody="Root cause identified: circular reference in cache.invalidate() prevents garbage collection. Fix requires breaking the cycle."
)]
"I've added your findings to issue def5678."
```

### Closing Issues

After fixing a problem:

```
User: "I've fixed the memory leak"

LLM: [uses git_artemis(
    command="close",
    issueId="def5678",
    closeCommentBody="Fixed by breaking the circular reference in cache.invalidate()"
)]
"Great! I've closed issue def5678 and marked it as resolved/fixed."
```

## Tips

1. **Be specific**: Provide detailed subject and body when creating issues
2. **Check existing**: Use `list` to see existing issues before creating duplicates
3. **Add context**: Use comments to add investigation notes, findings, or progress updates
4. **Reference commits**: Include commit hashes in issue bodies or comments when relevant
5. **Close when done**: Use the `close` command when issues are resolved

## Issue States

Issues start with `state=new` and can be closed with the `close` command, which sets:
- `state=resolved`
- `resolution=fixed`

This is the only state transition exposed by the tool. For other property management, use the `git artemis` command directly from your shell.

## Rendering

The extension provides custom TUI rendering:

- **Compact view**: Shows first 10 issues/lines
- **Expanded view** (Ctrl+O): Shows full output
- **Syntax highlighting**: Issue IDs highlighted in listings
- **Status indicators**: ✓ for success, ✗ for errors

## Limitations

- Cannot handle binary attachments
- No support for custom properties (only state=resolved/resolution=fixed via `close`)
- No support for date filters or `.issues/.filter*` files
- Requires a git repository with artemis initialized

## Troubleshooting

### "Not a git repository"

Make sure you're in a git repository with artemis initialized:

```bash
git artemis list
```

### "Command not found"

Install artemis:

```bash
# Check if installed
which git-artemis

# Install via Nix
nix-env -iA nixpkgs.artemis
```

### "No issues found"

This is normal for a fresh repository. Create your first issue:

```
git_artemis(
    command="add",
    subject="First issue",
    body="Testing artemis integration"
)
```

## See Also

- [pi documentation](https://github.com/badlogic/pi)
- [Extension development guide](https://github.com/badlogic/pi/blob/main/docs/extensions.md)
