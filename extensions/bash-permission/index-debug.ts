/**
 * Bash Permission Extension for Pi (DEBUG VERSION)
 * 
 * Adds extensive console.error logging to diagnose blocking issues.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

interface Config {
	allowedExact: string[];
	deniedExact: string[];
	allowedPrefixes: string[];
	deniedPrefixes: string[];
	confirmTimeout?: number;
}

const DEFAULT_CONFIG: Config = {
	allowedExact: [],
	deniedExact: [],
	allowedPrefixes: [],
	deniedPrefixes: [],
	confirmTimeout: 30000,
};

export default function (pi: ExtensionAPI) {
	console.error("[BASH-PERM-DEBUG] Extension loaded");
	
	const configPath = path.join(os.homedir(), ".config", "pi", "bash-permission.json");
	let config: Config = { ...DEFAULT_CONFIG };

	function loadConfig(): void {
		try {
			if (fs.existsSync(configPath)) {
				const data = fs.readFileSync(configPath, "utf-8");
				const loaded = JSON.parse(data);
				config = { ...DEFAULT_CONFIG, ...loaded };
				console.error("[BASH-PERM-DEBUG] Config loaded");
			}
		} catch (error) {
			console.error(`[BASH-PERM-DEBUG] Failed to load config:`, error);
		}
	}

	function checkCommand(command: string): "allowed" | "denied" | "unknown" {
		if (config.deniedExact.includes(command)) {
			return "denied";
		}
		if (config.allowedExact.includes(command)) {
			return "allowed";
		}

		for (const prefix of config.deniedPrefixes) {
			if (command.startsWith(prefix)) {
				return "denied";
			}
		}
		for (const prefix of config.allowedPrefixes) {
			if (command.startsWith(prefix)) {
				return "allowed";
			}
		}

		return "unknown";
	}

	pi.on("session_start", async (_event, _ctx) => {
		console.error("[BASH-PERM-DEBUG] Session started");
		loadConfig();
	});

	pi.on("tool_call", async (event, ctx) => {
		console.error(`[BASH-PERM-DEBUG] tool_call event: ${event.toolName}`);
		
		if (!isToolCallEventType("bash", event)) {
			console.error(`[BASH-PERM-DEBUG] Not a bash command, returning undefined`);
			return undefined;
		}

		const command = event.input.command;
		console.error(`[BASH-PERM-DEBUG] Bash command: ${command.substring(0, 50)}`);
		
		const status = checkCommand(command);
		console.error(`[BASH-PERM-DEBUG] Command status: ${status}`);

		if (status === "denied") {
			console.error(`[BASH-PERM-DEBUG] Blocking denied command`);
			return {
				block: true,
				reason: "Command denied by saved rule",
			};
		}

		if (status === "allowed") {
			console.error(`[BASH-PERM-DEBUG] Allowing saved command`);
			return undefined;
		}

		if (!ctx.hasUI) {
			console.error(`[BASH-PERM-DEBUG] No UI available, blocking`);
			return {
				block: true,
				reason: "Command requires confirmation but no UI available",
			};
		}

		console.error(`[BASH-PERM-DEBUG] Showing UI dialog...`);
		const choices = [
			"❌ Deny once",
			"✅ Allow once",
			"🚫 Deny prefix",
			"✓ Allow exact",
			"✓✓ Allow prefix",
		];

		console.error(`[BASH-PERM-DEBUG] Calling ctx.ui.select...`);
		const choice = await ctx.ui.select(
			`🔒 Bash Permission Required\n\nCommand: ${command}\n\nWhat would you like to do?`,
			choices,
			{ timeout: config.confirmTimeout }
		);
		console.error(`[BASH-PERM-DEBUG] UI select returned: ${choice}`);

		if (!choice) {
			console.error(`[BASH-PERM-DEBUG] No choice (timeout/cancel), blocking`);
			ctx.ui.notify("Command denied (timeout/cancelled)", "warning");
			return {
				block: true,
				reason: "User cancelled or timeout",
			};
		}

		console.error(`[BASH-PERM-DEBUG] User chose: ${choice}`);

		switch (choice) {
			case "❌ Deny once":
				console.error(`[BASH-PERM-DEBUG] Denying once`);
				ctx.ui.notify("Command denied", "info");
				return {
					block: true,
					reason: "User denied (one-time)",
				};

			case "✅ Allow once":
				console.error(`[BASH-PERM-DEBUG] Allowing once`);
				ctx.ui.notify("Command allowed (one-time)", "info");
				return undefined;

			default:
				console.error(`[BASH-PERM-DEBUG] Unknown choice: ${choice}`);
				return {
					block: true,
					reason: "Unknown choice",
				};
		}
	});

	console.error("[BASH-PERM-DEBUG] Extension initialization complete");
}
