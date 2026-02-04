/**
 * Artemis Extension - Git-based issue tracker integration
 *
 * This extension provides a `git_artemis` tool that wraps git artemis commands:
 * - git artemis list - List issues with state=new (or all with -a)
 * - git artemis add - Create an issue (subject + body)
 * - git artemis add <id> - Add comment to an issue
 * - git artemis show <id> - Show an issue
 * - git artemis show <id> <n> - Show comment n on an issue
 * - git artemis add <id> -p state=resolved -p resolution=fixed - Close an issue
 *
 * Use cases:
 * - Make notes of problems discovered during development
 * - Log information about known issues
 * - Track tasks and TODOs directly in the repository
 * - Close issues as work progresses
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface ArtemisDetails {
	command: string;
	stdout: string;
	stderr: string;
	exitCode: number;
}

const ArtemisParams = Type.Object({
	command: StringEnum(["list", "add", "show", "close"] as const, {
		description: "Command: list (show issues), add (create issue or comment), show (view issue/comment), close (mark issue resolved)",
	}),
	
	// For list
	all: Type.Optional(Type.Boolean({ 
		description: "Show all issues instead of just state=new (default: false)" 
	})),
	
	// For add (new issue)
	subject: Type.Optional(Type.String({ 
		description: "Issue subject/title (required for creating new issue)" 
	})),
	body: Type.Optional(Type.String({ 
		description: "Issue body/description (required for creating new issue)" 
	})),
	
	// For add (comment), show, close
	issueId: Type.Optional(Type.String({ 
		description: "Issue ID (required for comment, show, close)" 
	})),
	
	// For add (comment)
	commentBody: Type.Optional(Type.String({ 
		description: "Comment text (required for adding comment)" 
	})),
	
	// For show (comment)
	commentNumber: Type.Optional(Type.Number({ 
		description: "Comment number to show (optional, for 'show' command)" 
	})),
});

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "git_artemis",
		label: "Artemis",
		description: `Execute git artemis commands to manage issues.

Commands:
- list: List issues (shows state=new by default, use all=true for all issues)
  Example: git_artemis(command="list")
  Example: git_artemis(command="list", all=true)
  
- add: Create issue OR add comment
  New issue: git_artemis(command="add", subject="Bug in parser", body="Details about the bug...")
  Add comment: git_artemis(command="add", issueId="abc123", commentBody="Found the root cause...")
  
- show: Show issue or specific comment
  Show issue: git_artemis(command="show", issueId="abc123")
  Show comment: git_artemis(command="show", issueId="abc123", commentNumber=0)

- close: Close an issue (sets state=resolved, resolution=fixed)
  Example: git_artemis(command="close", issueId="abc123")

Use this to log problems, track tasks, and manage issue status.`,
		
		parameters: ArtemisParams,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			let editorScript: string | undefined;
			
			try {
				const args: string[] = [];
				let cmdString: string;
				
				if (params.command === "list") {
					args.push("list");
					if (!params.all) {
						// Default: only show state=new
						args.push("-p", "state=new");
					} else {
						args.push("-a");
					}
					cmdString = `git artemis ${args.join(" ")}`;
					
				} else if (params.command === "add") {
					args.push("add");
					
					if (params.issueId) {
						// Adding comment to existing issue
						if (!params.commentBody) {
							return {
								content: [{
									type: "text",
									text: "Error: commentBody required when adding comment to issue"
								}],
								details: {
									command: "git artemis add <id>",
									stdout: "",
									stderr: "missing commentBody",
									exitCode: 1,
								} as ArtemisDetails,
							};
						}
						
						// Create editor script that replaces "Detailed description." with actual comment body
						editorScript = join(tmpdir(), `artemis-editor-${Date.now()}.sh`);
						const scriptContent = `#!/bin/bash
# Read the body from a heredoc and use it to replace "Detailed description."
BODY=$(cat << 'BODY_END'
${params.commentBody}
BODY_END
)
# Replace "Detailed description." with the actual body
sed -i "s/Detailed description\\./$(printf '%s\\n' "$BODY" | sed 's/[&/\\]/\\\\&/g')/" "$1"
`;
						await writeFile(editorScript, scriptContent, { mode: 0o755 });
						
						args.push(params.issueId);
						cmdString = `EDITOR="${editorScript}" git artemis ${args.join(" ")}`;
						
					} else {
						// Creating new issue
						if (!params.subject || !params.body) {
							return {
								content: [{
									type: "text",
									text: "Error: subject and body required when creating new issue"
								}],
								details: {
									command: "git artemis add",
									stdout: "",
									stderr: "missing subject or body",
									exitCode: 1,
								} as ArtemisDetails,
							};
						}
						
						// Create editor script that replaces "Detailed description." with actual body
						editorScript = join(tmpdir(), `artemis-editor-${Date.now()}.sh`);
						// Use printf to properly escape the body text for sed
						const scriptContent = `#!/bin/bash
# Read the body from a heredoc and use it to replace "Detailed description."
BODY=$(cat << 'BODY_END'
${params.body}
BODY_END
)
# Replace "Detailed description." with the actual body
sed -i "s/Detailed description\\./$(printf '%s\\n' "$BODY" | sed 's/[&/\\]/\\\\&/g')/" "$1"
`;
						await writeFile(editorScript, scriptContent, { mode: 0o755 });
						
						args.push("-m", params.subject);
						cmdString = `EDITOR="${editorScript}" git artemis ${args.join(" ")}`;
					}
					
				} else if (params.command === "show") {
					if (!params.issueId) {
						return {
							content: [{
								type: "text",
								text: "Error: issueId required for 'show' command"
							}],
							details: {
								command: "git artemis show",
								stdout: "",
								stderr: "missing issueId",
								exitCode: 1,
							} as ArtemisDetails,
						};
					}
					
					args.push("show", params.issueId);
					if (params.commentNumber !== undefined) {
						args.push(String(params.commentNumber));
					}
					cmdString = `git artemis ${args.join(" ")}`;
					
				} else if (params.command === "close") {
					if (!params.issueId) {
						return {
							content: [{
								type: "text",
								text: "Error: issueId required for 'close' command"
							}],
							details: {
								command: "git artemis add <id> -p ...",
								stdout: "",
								stderr: "missing issueId",
								exitCode: 1,
							} as ArtemisDetails,
						};
					}
					
					args.push("add", params.issueId, "-p", "state=resolved", "-p", "resolution=fixed", "-n");
					cmdString = `git artemis ${args.join(" ")}`;
					
				} else {
					return {
						content: [{
							type: "text",
							text: `Error: unknown command '${params.command}'`
						}],
						details: {
							command: "git artemis",
							stdout: "",
							stderr: "unknown command",
							exitCode: 1,
						} as ArtemisDetails,
					};
				}

				// Show progress
				onUpdate?.({
					content: [{ type: "text", text: `Running: ${cmdString}` }],
				});

				// Execute command
				const env = { ...process.env };
				if (editorScript) {
					env.EDITOR = editorScript;
				}
				
				const result = await pi.exec("git", ["artemis", ...args], {
					signal,
					cwd: ctx.cwd,
					env,
				});

				// Check for cancellation
				if (signal?.aborted) {
					return {
						content: [{ type: "text", text: "Cancelled" }],
						details: {
							command: cmdString,
							stdout: "",
							stderr: "cancelled",
							exitCode: -1,
						} as ArtemisDetails,
					};
				}

				const stdout = result.stdout.trim();
				const stderr = result.stderr.trim();
				const success = result.code === 0;

				// Return output
				return {
					content: [{
						type: "text",
						text: success ? (stdout || "Success") : `Error: ${stderr || stdout || "Command failed"}`,
					}],
					details: {
						command: cmdString,
						stdout,
						stderr,
						exitCode: result.code,
					} as ArtemisDetails,
				};
				
			} finally {
				// Clean up editor script
				if (editorScript) {
					try {
						await unlink(editorScript);
					} catch {
						// Ignore cleanup errors
					}
				}
			}
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("artemis ")) + theme.fg("accent", args.command);
			
			if (args.issueId) {
				text += " " + theme.fg("muted", args.issueId);
			}
			
			if (args.subject) {
				text += " " + theme.fg("dim", `"${args.subject}"`);
			}
			
			if (args.commentNumber !== undefined) {
				text += " " + theme.fg("dim", `#${args.commentNumber}`);
			}
			
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as ArtemisDetails | undefined;
			
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			const success = details.exitCode === 0;
			const output = details.stdout || details.stderr;

			if (!success) {
				return new Text(theme.fg("error", `✗ ${output}`), 0, 0);
			}

			// For list command
			if (details.command.includes("list")) {
				if (!output) {
					return new Text(theme.fg("dim", "No issues found"), 0, 0);
				}
				
				const lines = output.split("\n").filter(l => l.trim());
				const displayLines = expanded ? lines : lines.slice(0, 10);
				
				let text = theme.fg("success", "✓ ") + theme.fg("muted", `${lines.length} issue(s):`);
				for (const line of displayLines) {
					// Highlight issue IDs
					const highlighted = line.replace(/([a-f0-9]{16})/g, (id) => theme.fg("accent", id));
					text += "\n" + theme.fg("muted", highlighted);
				}
				
				if (!expanded && lines.length > 10) {
					text += "\n" + theme.fg("dim", `... ${lines.length - 10} more`);
				}
				
				return new Text(text, 0, 0);
			}
			
			// For show command
			if (details.command.includes("show")) {
				const lines = output.split("\n");
				const displayLines = expanded ? lines : lines.slice(0, 8);
				
				let text = theme.fg("success", "✓");
				text += "\n" + theme.fg("muted", displayLines.join("\n"));
				
				if (!expanded && lines.length > 8) {
					text += "\n" + theme.fg("dim", `... ${lines.length - 8} more lines`);
				}
				
				return new Text(text, 0, 0);
			}
			
			// For add/close commands - extract issue ID if present
			if (details.command.includes("add")) {
				const issueIdMatch = output.match(/([a-f0-9]{16})/);
				if (issueIdMatch) {
					const issueId = theme.fg("accent", issueIdMatch[1]);
					return new Text(theme.fg("success", "✓ ") + theme.fg("muted", output.replace(issueIdMatch[1], issueId)), 0, 0);
				}
			}
			
			return new Text(theme.fg("success", "✓ ") + theme.fg("muted", output), 0, 0);
		},
	});
}
