/**
 * Bash Permission Extension for Pi
 * 
 * Requires confirmation before executing any bash command.
 * Provides flexible options to remember allowed/denied commands.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

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

export default function (pi: ExtensionAPI) {
	const configPath = path.join(os.homedir(), ".config", "pi", "bash-permission.json");
	let config: Config = { ...DEFAULT_CONFIG };
	
	// Debug logging to file
	const tempDir = process.env.TMPDIR || "/tmp";
	const logFile = path.join(tempDir, `bash-permission-ext-${process.pid}.log`);
	function log(message: string): void {
		try {
			const timestamp = Date.now();
			fs.appendFileSync(logFile, `[${timestamp}] [${process.pid}] ${message}\n`);
		} catch (e) {
			// Ignore logging errors
		}
	}

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
		// Check exact matches first
		if (config.deniedExact.includes(command)) {
			return "denied";
		}
		if (config.allowedExact.includes(command)) {
			return "allowed";
		}

		// Check prefixes
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

	// Write decision to FIFO (polls for FIFO to exist, then writes)
	async function writeFifoDecision(command: string, decision: "allow" | "deny"): Promise<void> {
		const hash = crypto.createHash("sha256").update(command).digest("hex");
		
		// Use standard temp directory (respect TMPDIR, fall back to /tmp)
		const tempDir = process.env.TMPDIR || "/tmp";
		const fifoPath = `${tempDir}/pi-bash-perm-${hash}.fifo`;

		log(`writeFifoDecision: command="${command}", decision="${decision}"`);
		log(`writeFifoDecision: hash=${hash}`);
		log(`writeFifoDecision: tempDir=${tempDir}`);
		log(`writeFifoDecision: fifoPath=${fifoPath}`);
		log(`writeFifoDecision: Starting poll...`);

		// Poll for FIFO to exist (wrapper creates it)
		// Need longer timeout because wrapper spawns asynchronously
		const maxAttempts = 100; // 10 seconds total
		const pollInterval = 100; // ms
		
		for (let i = 0; i < maxAttempts; i++) {
			if (fs.existsSync(fifoPath)) {
				// FIFO exists, write decision
				log(`writeFifoDecision: Found FIFO after ${i * pollInterval}ms`);
				try {
					fs.writeFileSync(fifoPath, decision + "\n");
					log(`writeFifoDecision: Successfully wrote decision`);
					return;
				} catch (error) {
					log(`writeFifoDecision: Failed to write: ${error}`);
					throw error;
				}
			}
			// Wait before next poll
			await new Promise(resolve => setTimeout(resolve, pollInterval));
		}

		// Timeout - FIFO never appeared
		log(`writeFifoDecision: TIMEOUT - FIFO not found after ${maxAttempts * pollInterval}ms`);
		throw new Error(`FIFO not found after ${maxAttempts * pollInterval}ms: ${fifoPath}`);
	}

	// Load config on session start
	pi.on("session_start", async (_event, _ctx) => {
		loadConfig();
	});

	// Intercept bash tool calls
	pi.on("tool_call", async (event, ctx) => {
		// Only intercept bash commands
		if (!isToolCallEventType("bash", event)) {
			return undefined;
		}

		const command = event.input.command;
		log(`tool_call: Intercepted bash command: ${command}`);
		
		const status = checkCommand(command);
		log(`tool_call: Check result: ${status}`);

		let decision: "allow" | "deny";

		// If denied by saved rule, deny immediately
		if (status === "denied") {
			decision = "deny";
			try {
				await writeFifoDecision(command, decision);
			} catch (error) {
				console.error("Failed to write FIFO decision:", error);
			}
			return undefined; // Wrapper handles blocking
		}

		// If allowed by saved rule, allow immediately
		if (status === "allowed") {
			decision = "allow";
			try {
				await writeFifoDecision(command, decision);
			} catch (error) {
				console.error("Failed to write FIFO decision:", error);
			}
			return undefined;
		}

		// Unknown command - need to ask user
		if (!ctx.hasUI) {
			// No UI available (non-interactive mode) - deny by default
			decision = "deny";
			try {
				await writeFifoDecision(command, decision);
			} catch (error) {
				console.error("Failed to write FIFO decision:", error);
			}
			return undefined;
		}

		// Show confirmation dialog
		const choices = [
			"❌ Deny once",
			"✅ Allow once",
			"🚫 Deny prefix",
			"✓ Allow exact",
			"✓✓ Allow prefix",
		];

		const choice = await ctx.ui.select(
			`🔒 Bash Permission Required\n\nCommand: ${command}\n\nWhat would you like to do?`,
			choices,
			{ timeout: config.confirmTimeout }
		);

		// Handle timeout or escape
		if (!choice) {
			ctx.ui.notify("Command denied (timeout/cancelled)", "warning");
			decision = "deny";
			try {
				await writeFifoDecision(command, decision);
			} catch (error) {
				console.error("Failed to write FIFO decision:", error);
			}
			return undefined;
		}

		switch (choice) {
			case "❌ Deny once":
				ctx.ui.notify("Command denied", "info");
				decision = "deny";
				break;

			case "✅ Allow once":
				ctx.ui.notify("Command allowed (one-time)", "info");
				decision = "allow";
				break;

			case "🚫 Deny prefix": {
				const prefix = await ctx.ui.input(
					"Enter command prefix to deny:",
					command
				);
				if (prefix) {
					config.deniedPrefixes.push(prefix);
					saveConfig();
					ctx.ui.notify(`Prefix denied and saved: "${prefix}"`, "success");
				}
				decision = "deny";
				break;
			}

			case "✓ Allow exact":
				config.allowedExact.push(command);
				saveConfig();
				ctx.ui.notify("Command allowed and saved (exact match)", "success");
				decision = "allow";
				break;

			case "✓✓ Allow prefix": {
				const prefix = await ctx.ui.input(
					"Enter command prefix to allow:",
					command
				);
				if (prefix) {
					config.allowedPrefixes.push(prefix);
					saveConfig();
					ctx.ui.notify(`Prefix allowed and saved: "${prefix}"`, "success");
					decision = "allow";
				} else {
					// User cancelled prefix input, deny the command
					decision = "deny";
				}
				break;
			}

			default:
				// Should never happen, but deny by default
				decision = "deny";
				break;
		}

		// Write decision to FIFO
		try {
			log(`tool_call: Writing decision "${decision}" to FIFO`);
			await writeFifoDecision(command, decision);
			log(`tool_call: Successfully wrote decision`);
		} catch (error) {
			log(`tool_call: Failed to write FIFO decision: ${error}`);
		}

		return undefined; // Wrapper handles blocking
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
				"📋 View all rules",
				"🗑️  Clear all rules",
				"📂 Open config file",
				"🔙 Cancel",
			];

			const action = await ctx.ui.select("Bash Permissions Management", actions);

			if (!action || action === "🔙 Cancel") {
				return;
			}

			if (action === "📋 View all rules") {
				let message = "Current Permission Rules:\n\n";
				
				if (config.allowedExact.length > 0) {
					message += "✅ Allowed (exact):\n";
					config.allowedExact.forEach((cmd) => {
						message += `  - ${cmd}\n`;
					});
					message += "\n";
				}
				
				if (config.allowedPrefixes.length > 0) {
					message += "✅ Allowed (prefix):\n";
					config.allowedPrefixes.forEach((prefix) => {
						message += `  - ${prefix}*\n`;
					});
					message += "\n";
				}
				
				if (config.deniedExact.length > 0) {
					message += "❌ Denied (exact):\n";
					config.deniedExact.forEach((cmd) => {
						message += `  - ${cmd}\n`;
					});
					message += "\n";
				}
				
				if (config.deniedPrefixes.length > 0) {
					message += "❌ Denied (prefix):\n";
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
			} else if (action === "🗑️  Clear all rules") {
				const confirmed = await ctx.ui.confirm(
					"Clear all rules?",
					"This will remove all saved allow/deny rules. You will be asked to confirm all commands again."
				);
				if (confirmed) {
					config = { ...DEFAULT_CONFIG };
					saveConfig();
					ctx.ui.notify("All permission rules cleared", "success");
				}
			} else if (action === "📂 Open config file") {
				ctx.ui.notify(`Config file location:\n${configPath}`, "info");
			}
		},
	});
}
