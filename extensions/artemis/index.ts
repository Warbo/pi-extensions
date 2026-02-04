/**
 * Artemis Extension - Git-based issue tracker integration
 *
 * This extension provides a `git_artemis` tool that wraps the git-artemis command,
 * allowing the LLM to:
 * - List issues and filter by properties
 * - Create new issues
 * - Add comments to existing issues
 * - View issue details
 * - Update issue properties (state, resolution, etc.)
 *
 * Use cases:
 * - Make notes of problems discovered during development
 * - Log information about known issues
 * - Track tasks and TODOs directly in the repository
 * - Close or update issue status as work progresses
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text, truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

interface ArtemisDetails {
	action: "list" | "add" | "show" | "update";
	stdout?: string;
	stderr?: string;
	exitCode: number;
	command: string;
	error?: string;
}

const ArtemisParams = Type.Object({
	action: StringEnum(["list", "add", "show", "update"] as const, {
		description: "Action to perform: list (show issues), add (create issue/comment), show (view issue details), update (change properties)",
	}),
	
	// For list action
	all: Type.Optional(Type.Boolean({ 
		description: "List all issues (default: only new/open issues)" 
	})),
	property: Type.Optional(Type.String({ 
		description: "Filter by property (e.g., 'state=new') or list property values (e.g., 'state')" 
	})),
	order: Type.Optional(StringEnum(["new", "latest"] as const, {
		description: "Order issues by: 'new' (date submitted) or 'latest' (last message)"
	})),
	
	// For add action (new issue)
	message: Type.Optional(Type.String({ 
		description: "Issue subject/title (for creating new issue)" 
	})),
	comment: Type.Optional(Type.String({ 
		description: "Issue description/body or comment text" 
	})),
	
	// For add/show/update actions (existing issue)
	issueId: Type.Optional(Type.String({ 
		description: "Issue ID to show, comment on, or update" 
	})),
	
	// For update action
	properties: Type.Optional(Type.Array(Type.String(), {
		description: "Properties to set (e.g., ['state=resolved', 'resolution=fixed'])"
	})),
	noPropertyComment: Type.Optional(Type.Boolean({
		description: "Don't add automatic comment about property changes"
	})),
});

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "git_artemis",
		label: "Artemis",
		description: `Manage issues using git-artemis issue tracker. 

Actions:
- list: Show issues (use 'all=true' for all, 'property' for filtering, 'order' for sorting)
- add: Create new issue (provide 'message' and optionally 'comment') OR add comment to existing issue (provide 'issueId')
- show: View issue details (provide 'issueId')
- update: Change issue properties (provide 'issueId' and 'properties' array like ['state=resolved', 'resolution=fixed'])

Common use cases:
- Log problems: git_artemis(action="add", message="Memory leak in worker", comment="Details...")
- Find tasks: git_artemis(action="list", property="state=new")
- Get details: git_artemis(action="show", issueId="abc123")
- Close issue: git_artemis(action="update", issueId="abc123", properties=["state=resolved", "resolution=fixed"])`,
		
		parameters: ArtemisParams,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			// Build git artemis command
			const args: string[] = [params.action];
			
			switch (params.action) {
				case "list":
					if (params.all) args.push("-a");
					if (params.property) args.push("-p", params.property);
					if (params.order) args.push("-o", params.order);
					break;
					
				case "add":
					if (params.issueId) {
						// Adding comment to existing issue - artemis doesn't support this via command line
						// The user needs to use an editor, so we'll return an error
						return {
							content: [{
								type: "text",
								text: "Error: Adding comments to existing issues requires interactive editor. Use 'show' to view the issue, then update properties if needed."
							}],
							details: {
								action: params.action,
								exitCode: 1,
								command: "git artemis add",
								error: "comment addition not supported via CLI"
							} as ArtemisDetails,
						};
					} else if (params.message) {
						// Creating new issue
						args.push("-m", params.message);
						if (params.properties) {
							params.properties.forEach(prop => {
								args.push("-p", prop);
							});
						}
					} else {
						return {
							content: [{
								type: "text",
								text: "Error: For 'add' action, provide 'message' to create new issue"
							}],
							details: {
								action: params.action,
								exitCode: 1,
								command: "git artemis add",
								error: "missing required parameters"
							} as ArtemisDetails,
						};
					}
					break;
					
				case "show":
					if (!params.issueId) {
						return {
							content: [{
								type: "text",
								text: "Error: 'issueId' required for 'show' action"
							}],
							details: {
								action: params.action,
								exitCode: 1,
								command: "git artemis show",
								error: "missing issueId"
							} as ArtemisDetails,
						};
					}
					args.push(params.issueId);
					break;
					
				case "update":
					if (!params.issueId || !params.properties || params.properties.length === 0) {
						return {
							content: [{
								type: "text",
								text: "Error: 'issueId' and 'properties' required for 'update' action"
							}],
							details: {
								action: params.action,
								exitCode: 1,
								command: "git artemis add",
								error: "missing issueId or properties"
							} as ArtemisDetails,
						};
					}
					// Update is implemented via 'add' with properties
					args[0] = "add";
					args.push(params.issueId);
					params.properties.forEach(prop => {
						args.push("-p", prop);
					});
					if (params.noPropertyComment) args.push("-n");
					break;
			}

			const command = `git artemis ${args.join(" ")}`;

			// Show progress
			onUpdate?.({
				content: [{ type: "text", text: `Running: ${command}` }],
			});

			// Execute command
			const result = await pi.exec("git", ["artemis", ...args], {
				signal,
				cwd: ctx.cwd,
			});

			// Check for cancellation
			if (signal?.aborted) {
				return {
					content: [{ type: "text", text: "Cancelled" }],
					details: {
						action: params.action,
						exitCode: -1,
						command,
						error: "cancelled"
					} as ArtemisDetails,
				};
			}

			const stdout = result.stdout.trim();
			const stderr = result.stderr.trim();
			const success = result.code === 0;

			// Format response based on action and success
			let responseText = "";
			if (success) {
				if (params.action === "list") {
					responseText = stdout || "No issues found";
				} else if (params.action === "show") {
					responseText = stdout || "Issue details not available";
				} else if (params.action === "add") {
					responseText = stdout || "Issue created successfully";
				} else if (params.action === "update") {
					responseText = stdout || `Issue ${params.issueId} updated`;
				}
			} else {
				responseText = `Error: ${stderr || stdout || "Command failed"}`;
			}

			return {
				content: [{
					type: "text",
					text: responseText,
				}],
				details: {
					action: params.action,
					stdout,
					stderr,
					exitCode: result.code,
					command,
					error: success ? undefined : (stderr || "command failed"),
				} as ArtemisDetails,
			};
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("artemis ")) + theme.fg("accent", args.action);
			
			if (args.issueId) {
				text += " " + theme.fg("muted", args.issueId);
			}
			
			if (args.message) {
				text += " " + theme.fg("dim", `"${truncateToWidth(args.message, 40)}"`);
			}
			
			if (args.property) {
				text += " " + theme.fg("dim", `[${args.property}]`);
			}
			
			if (args.properties && args.properties.length > 0) {
				text += " " + theme.fg("dim", `[${args.properties.join(", ")}]`);
			}
			
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as ArtemisDetails | undefined;
			
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			if (details.error) {
				return new Text(theme.fg("error", `✗ Error: ${details.error}`), 0, 0);
			}

			const text = result.content[0];
			const output = text?.type === "text" ? text.text : "";
			
			// For list action, show formatted output
			if (details.action === "list") {
				if (!output || output === "No issues found") {
					return new Text(theme.fg("dim", "No issues found"), 0, 0);
				}
				
				let displayText = theme.fg("success", "✓ Issues:");
				const lines = output.split("\n");
				const displayLines = expanded ? lines : lines.slice(0, 10);
				
				for (const line of displayLines) {
					if (line.trim()) {
						// Highlight issue IDs in the output
						const highlighted = line.replace(/([a-f0-9]{7,})/g, (match) => 
							theme.fg("accent", match)
						);
						displayText += "\n" + theme.fg("muted", highlighted);
					}
				}
				
				if (!expanded && lines.length > 10) {
					displayText += "\n" + theme.fg("dim", `... ${lines.length - 10} more issues`);
				}
				
				return new Text(displayText, 0, 0);
			}
			
			// For show action, display issue details
			if (details.action === "show") {
				let displayText = theme.fg("success", "✓ Issue details:");
				
				if (expanded) {
					displayText += "\n" + theme.fg("muted", output);
				} else {
					// Show first few lines in collapsed view
					const lines = output.split("\n");
					const preview = lines.slice(0, 5).join("\n");
					displayText += "\n" + theme.fg("muted", preview);
					if (lines.length > 5) {
						displayText += "\n" + theme.fg("dim", `... ${lines.length - 5} more lines`);
					}
				}
				
				return new Text(displayText, 0, 0);
			}
			
			// For add/update actions, show success message
			if (details.action === "add" || details.action === "update") {
				return new Text(
					theme.fg("success", "✓ ") + theme.fg("muted", output),
					0,
					0
				);
			}
			
			return new Text(theme.fg("muted", output), 0, 0);
		},
	});
}
