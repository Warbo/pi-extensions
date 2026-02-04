/**
 * Bash Permission Extension for Pi
 * 
 * Requires confirmation before executing bash commands.
 * Provides flexible options to remember allowed/denied commands.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

interface Config {
	// Commands that are always allowed (exact match)
	allowedExact: string[];
	// Commands that are always denied (exact match)
	deniedExact: string[];
	// Command prefixes that are always allowed
	allowedPrefixes: string[];
	// Command prefixes that are always denied
	deniedPrefixes: string[];
	// Timeout for confirmation dialog (milliseconds)
	confirmTimeout?: number;
}

const DEFAULT_CONFIG: Config = {
	allowedExact: [],
	deniedExact: [],
	allowedPrefixes: [],
	deniedPrefixes: [],
	confirmTimeout: 30000, // 30 seconds default
};

const CHOICES = {
	DENY_ONCE: "Deny once",
	ALLOW_ONCE: "Allow once",
	DENY_PREFIX: "Deny prefix",
	ALLOW_EXACT: "Allow exact",
	ALLOW_PREFIX: "Allow prefix",
} as const;

const ACTIONS = {
	VIEW_ALL_RULES: "View all rules",
	CLEAR_ALL_RULES: "Clear all rules",
	OPEN_CONFIG_FILE: "Open config file",
	CANCEL: "Cancel",
} as const;

export default function (pi: ExtensionAPI) {
	const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
	const configPath = path.join(configHome, "pi", "bash-permission.json");
	let config: Config = { ...DEFAULT_CONFIG };

	// Load config on startup
	function loadConfig(): void {
		try {
			if (fs.existsSync(configPath)) {
				const data = fs.readFileSync(configPath, "utf-8");
				const loaded = JSON.parse(data);
				config = { ...DEFAULT_CONFIG, ...loaded };
			}
		} catch (error) {
			console.error(`Failed to load config from ${configPath}:`, error);
		}
	}

	// Save config to disk
	function saveConfig(): void {
		try {
			const dir = path.dirname(configPath);
			if (!fs.existsSync(dir)) {
				fs.mkdirSync(dir, { recursive: true });
			}
			fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
		} catch (error) {
			console.error(`Failed to save config to ${configPath}:`, error);
		}
	}

	// Check if a command matches any of the stored rules
	function checkCommand(command: string): "allowed" | "denied" | "unknown" {
		// Check exact matches first (deny takes precedence)
		if (config.deniedExact.includes(command)) {
			return "denied";
		}
		if (config.allowedExact.includes(command)) {
			return "allowed";
		}

		// Check prefixes (deny takes precedence)
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

	// Load config on session start
	pi.on("session_start", async (_event, _ctx) => {
		loadConfig();
	});

	// Intercept bash tool calls
	pi.on("tool_call", async (event, ctx) => {
		// Only intercept bash commands
		if (event.toolName !== "bash") {
			return undefined;
		}

		const command = event.input.command as string;
		const status = checkCommand(command);

		// If denied by saved rule, block immediately
		if (status === "denied") {
			return { block: true, reason: "Blocked by saved rule" };
		}

		// If allowed by saved rule, allow immediately
		if (status === "allowed") {
			return undefined;
		}

		// Unknown command - need to ask user
		if (!ctx.hasUI) {
			// No UI available (non-interactive mode) - deny by default
			return { block: true, reason: "Blocked (no UI for confirmation)" };
		}

		// Show confirmation dialog
		const choices = [
			CHOICES.DENY_ONCE,
			CHOICES.ALLOW_ONCE,
			CHOICES.DENY_PREFIX,
			CHOICES.ALLOW_EXACT,
			CHOICES.ALLOW_PREFIX,
		];

		const choice = await ctx.ui.select(
			`Bash Permission Required\n\nCommand: ${command}\n\nWhat would you like to do?`,
			choices,
			{ timeout: config.confirmTimeout }
		);

		// Handle timeout or escape
		if (!choice) {
			ctx.ui.notify("Command denied (timeout/cancelled)", "warning");
			return { block: true, reason: "Denied by timeout/cancel" };
		}

		switch (choice) {
			case CHOICES.DENY_ONCE:
				ctx.ui.notify("Command denied", "info");
				return { block: true, reason: "Denied by user" };

			case CHOICES.ALLOW_ONCE:
				ctx.ui.notify("Command allowed (one-time)", "info");
				return undefined;

			case CHOICES.DENY_PREFIX: {
				const prefix = await ctx.ui.input(
					"Enter command prefix to deny:",
					command
				);
				if (prefix) {
					config.deniedPrefixes.push(prefix);
					saveConfig();
					ctx.ui.notify(`Prefix denied and saved: "${prefix}"`, "success");
				}
				return { block: true, reason: "Denied by user (prefix saved)" };
			}

			case CHOICES.ALLOW_EXACT:
				config.allowedExact.push(command);
				saveConfig();
				ctx.ui.notify("Command allowed and saved (exact match)", "success");
				return undefined;

			case CHOICES.ALLOW_PREFIX: {
				const prefix = await ctx.ui.input(
					"Enter command prefix to allow:",
					command
				);
				if (prefix) {
					config.allowedPrefixes.push(prefix);
					saveConfig();
					ctx.ui.notify(`Prefix allowed and saved: "${prefix}"`, "success");
					return undefined;
				} else {
					// User cancelled prefix input, deny the command
					return { block: true, reason: "Denied (prefix input cancelled)" };
				}
			}

			default:
				// Should never happen, but deny by default
				return { block: true, reason: "Unknown choice" };
		}
	});

	// Register a command to view/manage permissions
	pi.registerCommand("permissions", {
		description: "View and manage bash command permissions",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				console.log("Config file:", configPath);
				console.log(JSON.stringify(config, null, 2));
				return;
			}

			const actions = [
				ACTIONS.VIEW_ALL_RULES,
				ACTIONS.CLEAR_ALL_RULES,
				ACTIONS.OPEN_CONFIG_FILE,
				ACTIONS.CANCEL,
			];

			const action = await ctx.ui.select("Bash Permissions Management", actions);

			if (!action || action === ACTIONS.CANCEL) {
				return;
			}

			if (action === ACTIONS.VIEW_ALL_RULES) {
				let message = "Current Permission Rules:\n\n";
				
				if (config.allowedExact.length > 0) {
					message += "Allowed (exact):\n";
					config.allowedExact.forEach((cmd) => {
						message += `  - ${cmd}\n`;
					});
					message += "\n";
				}
				
				if (config.allowedPrefixes.length > 0) {
					message += "Allowed (prefix):\n";
					config.allowedPrefixes.forEach((prefix) => {
						message += `  - ${prefix}*\n`;
					});
					message += "\n";
				}
				
				if (config.deniedExact.length > 0) {
					message += "Denied (exact):\n";
					config.deniedExact.forEach((cmd) => {
						message += `  - ${cmd}\n`;
					});
					message += "\n";
				}
				
				if (config.deniedPrefixes.length > 0) {
					message += "Denied (prefix):\n";
					config.deniedPrefixes.forEach((prefix) => {
						message += `  - ${prefix}*\n`;
					});
				}

				if (
					config.allowedExact.length === 0 &&
					config.allowedPrefixes.length === 0 &&
					config.deniedExact.length === 0 &&
					config.deniedPrefixes.length === 0
				) {
					message += "No rules configured yet.";
				}

				ctx.ui.notify(message, "info");
			} else if (action === ACTIONS.CLEAR_ALL_RULES) {
				const confirmed = await ctx.ui.confirm(
					"Clear all rules?",
					"This will remove all saved allow/deny rules. You will be asked to confirm all commands again."
				);
				if (confirmed) {
					config = { ...DEFAULT_CONFIG };
					saveConfig();
					ctx.ui.notify("All permission rules cleared", "success");
				}
			} else if (action === ACTIONS.OPEN_CONFIG_FILE) {
				ctx.ui.notify(`Config file location:\n${configPath}`, "info");
			}
		},
	});
}
