# Artemis Extension

A pi extension that integrates the artemis git-based issue tracker, allowing the LLM to manage issues, tasks, and notes directly within your repository.

## Overview

The artemis extension provides five tools that wrap the `git artemis` command, enabling the LLM to:

- **Track issues**: Create and manage issues as the LLM discovers problems
- **Log information**: Document findings about known issues
- **Manage tasks**: Find and track TODOs directly in the repository
- **Update status**: Close or comment on issues as work progresses

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

The extension provides five tools, one per operation.

### Tools

#### `list_issues` (`git artemis list`)

Lists issues with `state=new` by default:

```
List open issues (default):
list_issues()

List all issues including resolved:
list_issues(all=true)
```

#### `new_issue` (`git artemis add`)

Creates a new issue with subject and body:

```
new_issue(
    subject="Memory leak in worker process",
    body="Observed when processing large files over 1GB. Memory usage grows unbounded and never gets freed."
)
```

#### `comment_issue` (`git artemis add <id>`)

Adds a comment to an existing issue. The subject line is left unchanged
(inherited from the original issue); only the issue ID and comment `body`
are required:

```
comment_issue(
    issueId="abc1234",
    body="Found the root cause - circular reference in cache invalidation"
)
```

#### `show_issue` (`git artemis show <id>`)

Shows an issue (without comments):

```
show_issue(issueId="abc1234")
```

Optionally pass `commentNumber` to show a specific comment (0-indexed):

```
show_issue(issueId="abc1234", commentNumber=0)
```

#### `close_issue` (`git artemis add <id> -p state=resolved -p resolution=fixed`)

Closes an issue and adds a closing comment. Like all comments, the subject
line is left unchanged:

```
close_issue(
    issueId="abc1234",
    body="Fixed in commit abc1234 — circular reference removed"
)
```

## Example Workflows

### Problem Discovery

When the LLM finds an issue during code review:

```
User: "Review the authentication code for security issues"

LLM: [uses new_issue(
    subject="SQL injection in auth module",
    body="Found potential SQL injection in user_login() function at line 42. User input is concatenated directly into query."
)]
"I found a potential SQL injection vulnerability. I've logged it as issue abc1234."
```

### Task Management

Finding work to do:

```
User: "What issues need attention?"

LLM: [uses list_issues()]
"There are 3 open issues:
1. abc1234 - SQL injection in auth
2. def5678 - Memory leak in worker
3. ghi9012 - Refactor config loading"
```

### Adding Investigation Notes

Documenting findings on an issue:

```
User: "I found the cause of issue def5678"

LLM: [uses comment_issue(
    issueId="def5678",
    body="Root cause identified: circular reference in cache.invalidate() prevents garbage collection. Fix requires breaking the cycle."
)]
"I've added your findings to issue def5678."
```

### Closing Issues

After fixing a problem:

```
User: "I've fixed the memory leak"

LLM: [uses close_issue(
    issueId="def5678",
    body="Fixed by breaking the circular reference in cache.invalidate()"
)]
"Great! I've closed issue def5678 and marked it as resolved/fixed."
```

## Tips

1. **Be specific**: Provide detailed subject and body when creating issues
2. **Check existing**: Use `list_issues` to see existing issues before creating duplicates
3. **Add context**: Use `comment_issue` to add investigation notes, findings, or progress updates
4. **Reference commits**: Include commit hashes in issue bodies or comments when relevant
5. **Close when done**: Use `close_issue` when issues are resolved

## Issue States

Issues start with `state=new` and can be closed with `close_issue`, which sets:
- `state=resolved`
- `resolution=fixed`

This is the only state transition exposed by the tools. For other property management, use the `git artemis` command directly from your shell.

## Rendering

The extension provides custom TUI rendering:

- **Compact view**: Shows first 10 issues/lines
- **Expanded view** (Ctrl+O): Shows full output
- **Syntax highlighting**: Issue IDs highlighted in listings
- **Status indicators**: ✓ for success, ✗ for errors

## Limitations

- Cannot handle binary attachments
- No support for custom properties (only state=resolved/resolution=fixed via `close_issue`)
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
new_issue(
    subject="First issue",
    body="Testing artemis integration"
)
```

## See Also

- [pi documentation](https://github.com/badlogic/pi)
- [Extension development guide](https://github.com/badlogic/pi/blob/main/docs/extensions.md)
