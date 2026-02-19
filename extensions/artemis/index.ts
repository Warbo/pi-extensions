/**
 * Artemis Extension - Git-based issue tracker integration
 *
 * Provides five tools wrapping git artemis commands:
 * - issues_list:    List issues (state=new by default, or all)
 * - issues_new:     Create a new issue with subject and body
 * - issues_comment: Add a comment to an existing issue
 * - issues_show:    Show an issue or a specific comment
 * - issues_close:   Close an issue (sets state=resolved, resolution=fixed)
 *
 * Use cases:
 * - Make notes of problems discovered during development
 * - Log information about known issues
 * - Track tasks and TODOs directly in the repository
 * - Close issues as work progresses
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { unlink } from "node:fs/promises";
import { createEditorScript, writeEditorScript } from "./editor.mjs";

interface ArtemisDetails {
	command: string;
	stdout: string;
	stderr: string;
	exitCode: number;
}

/**
 * Run a git artemis command that requires an EDITOR script to write content.
 * Writes a temporary editor script, runs the command with it, then cleans up.
 */
async function runWithEditor(
	pi: ExtensionAPI,
	args: string[],
	env: Record<string, string>,
	signal: AbortSignal | undefined,
	cwd: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
	const editorScript = await writeEditorScript(createEditorScript());
	try {
		const envParts = [
			`EDITOR='${editorScript}'`,
			...Object.entries(env).map(([k, v]) => `${k}='${v.replace(/'/g, "'\\''")}'`),
		];
		const shellCmd = `${envParts.join(" ")} git artemis ${args.join(" ")}`;
		return await pi.exec("sh", ["-c", shellCmd], { signal, cwd });
	} finally {
		try { await unlink(editorScript); } catch { /* ignore cleanup errors */ }
	}
}

/** Build a standard cancelled result. */
function cancelledResult(cmdString: string) {
	return {
		content: [{ type: "text" as const, text: "Cancelled" }],
		details: { command: cmdString, stdout: "", stderr: "cancelled", exitCode: -1 } as ArtemisDetails,
	};
}

/** Build a result from a raw exec output. */
function execResult(cmdString: string, stdout: string, stderr: string, code: number, fallbackOk: string) {
	const success = code === 0;
	return {
		content: [{
			type: "text" as const,
			text: success ? (stdout || fallbackOk) : `Error: ${stderr || stdout || "Command failed"}`,
		}],
		details: { command: cmdString, stdout, stderr, exitCode: code } as ArtemisDetails,
	};
}

export default function (pi: ExtensionAPI) {

	// ── issues_list ─────────────────────────────────────────────────────────────

	pi.registerTool({
		name: "issues_list",
		label: "List Issues",
		description: "List artemis issues. Shows only open issues (state=new) by default; set all=true to include resolved issues.",
		parameters: Type.Object({
			all: Type.Optional(Type.Boolean({
				description: "Show all issues instead of just state=new (default: false)",
			})),
		}),

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const args = params.all ? ["list", "-a"] : ["list", "-p", "state=new"];
			const cmdString = `git artemis ${args.join(" ")}`;
			onUpdate?.({ content: [{ type: "text", text: `Running: ${cmdString}` }] });

			const result = await pi.exec("git", ["artemis", ...args], { signal, cwd: ctx.cwd });
			if (signal?.aborted) return cancelledResult(cmdString);

			const stdout = result.stdout.trim();
			const stderr = result.stderr.trim();
			return execResult(cmdString, stdout, stderr, result.code, "No issues found");
		},

		renderCall(args, theme) {
			const suffix = args.all ? theme.fg("dim", " --all") : "";
			return new Text(theme.fg("toolTitle", theme.bold("artemis ")) + theme.fg("accent", "list") + suffix, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as ArtemisDetails | undefined;
			if (!details) return new Text(result.content[0]?.type === "text" ? result.content[0].text : "", 0, 0);
			if (details.exitCode !== 0) return new Text(theme.fg("error", `✗ ${details.stderr || details.stdout}`), 0, 0);

			const output = details.stdout;
			if (!output) return new Text(theme.fg("dim", "No issues found"), 0, 0);

			const lines = output.split("\n").filter(l => l.trim());
			const displayLines = expanded ? lines : lines.slice(0, 10);

			let text = theme.fg("success", "✓ ") + theme.fg("muted", `${lines.length} issue(s):`);
			for (const line of displayLines) {
				const highlighted = line.replace(/([a-f0-9]{16})/g, (id) => theme.fg("accent", id));
				text += "\n" + theme.fg("muted", highlighted);
			}
			if (!expanded && lines.length > 10) {
				text += "\n" + theme.fg("dim", `... ${lines.length - 10} more`);
			}
			return new Text(text, 0, 0);
		},
	});

	// ── issues_new ────────────────────────────────────────────────────────────────

	pi.registerTool({
		name: "issues_new",
		label: "New Issue",
		description: "Create a new artemis issue with a subject line and body text.",
		parameters: Type.Object({
			subject: Type.String({ description: "Issue subject/title" }),
			body: Type.String({ description: "Issue body/description" }),
		}),

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const cmdString = "git artemis add (with EDITOR)";
			onUpdate?.({ content: [{ type: "text", text: `Running: ${cmdString}` }] });

			const result = await runWithEditor(pi, ["add"], { SUBJECT: params.subject, BODY: params.body }, signal, ctx.cwd);
			if (signal?.aborted) return cancelledResult(cmdString);

			const stdout = result.stdout.trim();
			const stderr = result.stderr.trim();
			return execResult(cmdString, stdout, stderr, result.code, "Issue created");
		},

		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("artemis ")) + theme.fg("accent", "new") + " " + theme.fg("dim", `"${args.subject}"`),
				0, 0,
			);
		},

		renderResult(result, _opts, theme) {
			const details = result.details as ArtemisDetails | undefined;
			if (!details) return new Text(result.content[0]?.type === "text" ? result.content[0].text : "", 0, 0);
			if (details.exitCode !== 0) return new Text(theme.fg("error", `✗ ${details.stderr || details.stdout}`), 0, 0);

			const output = details.stdout;
			const issueIdMatch = output.match(/([a-f0-9]{16})/);
			const highlighted = issueIdMatch
				? output.replace(issueIdMatch[1], theme.fg("accent", issueIdMatch[1]))
				: output || "Issue created";
			return new Text(theme.fg("success", "✓ ") + theme.fg("muted", highlighted), 0, 0);
		},
	});

	// ── issues_comment ────────────────────────────────────────────────────────────

	pi.registerTool({
		name: "issues_comment",
		label: "Comment Issue",
		description: "Add a comment to an existing artemis issue.",
		parameters: Type.Object({
			issueId: Type.String({ description: "ID of the issue to comment on" }),
			body: Type.String({ description: "Comment text" }),
		}),

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const cmdString = `git artemis add ${params.issueId} (with EDITOR)`;
			onUpdate?.({ content: [{ type: "text", text: `Running: ${cmdString}` }] });

			const result = await runWithEditor(pi, ["add", params.issueId], { BODY: params.body }, signal, ctx.cwd);
			if (signal?.aborted) return cancelledResult(cmdString);

			const stdout = result.stdout.trim();
			const stderr = result.stderr.trim();
			return execResult(cmdString, stdout, stderr, result.code, "Comment added");
		},

		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("artemis ")) + theme.fg("accent", "comment") + " " + theme.fg("muted", args.issueId),
				0, 0,
			);
		},

		renderResult(result, _opts, theme) {
			const details = result.details as ArtemisDetails | undefined;
			if (!details) return new Text(result.content[0]?.type === "text" ? result.content[0].text : "", 0, 0);
			if (details.exitCode !== 0) return new Text(theme.fg("error", `✗ ${details.stderr || details.stdout}`), 0, 0);

			return new Text(theme.fg("success", "✓ ") + theme.fg("muted", details.stdout || "Comment added"), 0, 0);
		},
	});

	// ── issues_show ───────────────────────────────────────────────────────────────

	pi.registerTool({
		name: "issues_show",
		label: "Show Issue",
		description: "Show an artemis issue. Optionally pass commentNumber to show a specific comment (0-indexed).",
		parameters: Type.Object({
			issueId: Type.String({ description: "ID of the issue to show" }),
			commentNumber: Type.Optional(Type.Number({ description: "Comment number to show (0-indexed)" })),
		}),

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const args = ["show", params.issueId];
			if (params.commentNumber !== undefined) args.push(String(params.commentNumber));
			const cmdString = `git artemis ${args.join(" ")}`;
			onUpdate?.({ content: [{ type: "text", text: `Running: ${cmdString}` }] });

			const result = await pi.exec("git", ["artemis", ...args], { signal, cwd: ctx.cwd });
			if (signal?.aborted) return cancelledResult(cmdString);

			const stdout = result.stdout.trim();
			const stderr = result.stderr.trim();
			return execResult(cmdString, stdout, stderr, result.code, "No output");
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("artemis ")) + theme.fg("accent", "show") + " " + theme.fg("muted", args.issueId);
			if (args.commentNumber !== undefined) text += theme.fg("dim", ` #${args.commentNumber}`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as ArtemisDetails | undefined;
			if (!details) return new Text(result.content[0]?.type === "text" ? result.content[0].text : "", 0, 0);
			if (details.exitCode !== 0) return new Text(theme.fg("error", `✗ ${details.stderr || details.stdout}`), 0, 0);

			const lines = details.stdout.split("\n");
			const displayLines = expanded ? lines : lines.slice(0, 8);
			let text = theme.fg("success", "✓") + "\n" + theme.fg("muted", displayLines.join("\n"));
			if (!expanded && lines.length > 8) text += "\n" + theme.fg("dim", `... ${lines.length - 8} more lines`);
			return new Text(text, 0, 0);
		},
	});

	// ── issues_close ──────────────────────────────────────────────────────────────

	pi.registerTool({
		name: "issues_close",
		label: "Close Issue",
		description: "Close an artemis issue (sets state=resolved, resolution=fixed) and add a closing comment.",
		parameters: Type.Object({
			issueId: Type.String({ description: "ID of the issue to close" }),
			body: Type.String({ description: "Closing comment text" }),
		}),

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const args = ["add", params.issueId, "-p", "state=resolved", "-p", "resolution=fixed"];
			const cmdString = `git artemis ${args.join(" ")} (with EDITOR)`;
			onUpdate?.({ content: [{ type: "text", text: `Running: ${cmdString}` }] });

			const result = await runWithEditor(pi, args, { BODY: params.body }, signal, ctx.cwd);
			if (signal?.aborted) return cancelledResult(cmdString);

			const stdout = result.stdout.trim();
			const stderr = result.stderr.trim();
			return execResult(cmdString, stdout, stderr, result.code, "Issue closed");
		},

		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("artemis ")) + theme.fg("accent", "close") + " " + theme.fg("muted", args.issueId),
				0, 0,
			);
		},

		renderResult(result, _opts, theme) {
			const details = result.details as ArtemisDetails | undefined;
			if (!details) return new Text(result.content[0]?.type === "text" ? result.content[0].text : "", 0, 0);
			if (details.exitCode !== 0) return new Text(theme.fg("error", `✗ ${details.stderr || details.stdout}`), 0, 0);

			return new Text(theme.fg("success", "✓ ") + theme.fg("muted", details.stdout || "Issue closed"), 0, 0);
		},
	});
}
