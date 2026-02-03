#!/usr/bin/env node
/**
 * Debug integration test for bash-permission denial
 * Captures detailed event flow to diagnose blocking issues
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Get wrapper path from environment (set by Nix during tests)
const wrapperPath = process.env.bashPermissionWrapper;
if (!wrapperPath) {
	console.error("FATAL: bashPermissionWrapper environment variable not set");
	console.error("These tests must be run through Nix, not directly");
	process.exit(1);
}

// Start pi in RPC mode with extensions and wrapper configured
function startPi(extensions) {
	// Create temp directory with .pi/settings.json
	const tempDir = join(tmpdir(), `pi-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });
	mkdirSync(join(tempDir, ".pi"), { recursive: true });
	
	// Create settings.json with shellPath pointing to wrapper
	const settings = {
		shellPath: wrapperPath
	};
	writeFileSync(join(tempDir, ".pi", "settings.json"), JSON.stringify(settings, null, 2));
	
	const args = [
		"--mode", "rpc",
		"--no-session",
		"--provider", "dummy",
		"--model", "dummy-model",
	];
	
	for (const ext of extensions) {
		args.push("-e", ext);
	}
	
	const proc = spawn("pi", args, {
		stdio: ["pipe", "pipe", "pipe"],
		cwd: tempDir
	});
	
	// Clean up temp dir when process exits
	proc.on("close", () => {
		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch (e) {
			// Ignore cleanup errors
		}
	});
	
	return proc;
}

// Send JSON command to pi
function sendCommand(proc, cmd) {
	const json = JSON.stringify(cmd);
	console.error(`>>> SEND: ${json.substring(0, 100)}${json.length > 100 ? '...' : ''}`);
	proc.stdin.write(json + "\n");
}

// Main test
async function runDebugTest() {
	const dummyLLM = join(__dirname, "test-dummy-llm.ts");
	const bashPermission = join(__dirname, "index.ts");
	
	const pi = startPi([dummyLLM, bashPermission]);
	
	// Collect events with timestamps
	const events = [];
	const readline = createInterface({ input: pi.stdout });
	
	readline.on("line", (line) => {
		try {
			const event = JSON.parse(line);
			const timestamp = Date.now();
			events.push({ ...event, _timestamp: timestamp });
			
			// Log key events
			if (event.type === "extension_ui_request") {
				console.error(`<<< ${timestamp}: extension_ui_request: ${event.method} (id=${event.id})`);
			} else if (event.type === "tool_execution_start") {
				console.error(`<<< ${timestamp}: tool_execution_start: ${event.toolName} ${event.args?.command || ''}`);
			} else if (event.type === "tool_execution_end") {
				console.error(`<<< ${timestamp}: tool_execution_end: ${event.toolName} ${event.result?.error ? 'ERROR' : 'OK'}`);
			} else if (event.type === "agent_start" || event.type === "agent_end") {
				console.error(`<<< ${timestamp}: ${event.type}`);
			} else if (event.type === "turn_start" || event.type === "turn_end") {
				console.error(`<<< ${timestamp}: ${event.type}`);
			}
		} catch (e) {
			console.error("Failed to parse JSON:", line);
		}
	});
	
	// Collect stderr
	pi.stderr.on("data", (data) => {
		const lines = data.toString().split('\n').filter(l => l.trim());
		lines.forEach(line => console.error(`[STDERR] ${line}`));
	});
	
	console.error("\n=== TEST: Deny once blocks command ===\n");
	
	// Send prompt that triggers bash command
	sendCommand(pi, { type: "prompt", message: "list files" });
	
	// Wait for UI request
	console.error("\nWaiting for UI request...");
	let uiRequest;
	for (let i = 0; i < 200; i++) {
		await new Promise(resolve => setTimeout(resolve, 50));
		uiRequest = events.find(e => e.type === "extension_ui_request" && e.method === "select");
		if (uiRequest) break;
	}
	
	if (!uiRequest) {
		console.error("ERROR: No UI request received!");
		pi.kill();
		process.exit(1);
	}
	
	console.error(`\nGot UI request at ${uiRequest._timestamp}`);
	console.error(`Title: ${uiRequest.title}`);
	console.error(`Options: ${JSON.stringify(uiRequest.options)}`);
	
	// Check if bash already started before we respond
	const earlyBashStart = events.find(e => e.type === "tool_execution_start" && e.toolName === "bash");
	if (earlyBashStart) {
		console.error(`\n⚠️  WARNING: Bash already started at ${earlyBashStart._timestamp} before UI response!`);
		console.error(`Time delta: ${earlyBashStart._timestamp - uiRequest._timestamp}ms`);
	}
	
	// Respond with "Deny once"
	const responseTime = Date.now();
	sendCommand(pi, {
		type: "extension_ui_response",
		id: uiRequest.id,
		value: "❌ Deny once"
	});
	
	console.error(`\nSent deny response at ${responseTime}`);
	
	// Wait for more events
	console.error("\nWaiting for events after denial...");
	await new Promise(resolve => setTimeout(resolve, 5000));
	
	// Analyze what happened
	console.error("\n=== EVENT SEQUENCE ===");
	const relevantEvents = events.filter(e => 
		e.type === "turn_start" ||
		e.type === "turn_end" ||
		e.type === "extension_ui_request" ||
		e.type === "tool_execution_start" ||
		e.type === "tool_execution_end" ||
		e.type === "agent_end"
	);
	
	relevantEvents.forEach((e, i) => {
		const delta = i > 0 ? `+${e._timestamp - relevantEvents[i-1]._timestamp}ms` : '';
		if (e.type === "extension_ui_request") {
			console.error(`  ${i+1}. [${delta}] ${e.type}: ${e.method} (id=${e.id})`);
		} else if (e.type === "tool_execution_start") {
			console.error(`  ${i+1}. [${delta}] ${e.type}: ${e.toolName} ${e.args?.command || ''}`);
		} else if (e.type === "tool_execution_end") {
			console.error(`  ${i+1}. [${delta}] ${e.type}: ${e.toolName}`);
			if (e.result?.error) {
				console.error(`       Error: ${e.result.error}`);
			}
		} else {
			console.error(`  ${i+1}. [${delta}] ${e.type}`);
		}
	});
	
	// Check final result
	const bashExecutions = events.filter(e => e.type === "tool_execution_start" && e.toolName === "bash");
	
	console.error("\n=== RESULTS ===");
	console.error(`Total bash executions: ${bashExecutions.length}`);
	
	if (bashExecutions.length === 0) {
		console.error("✅ SUCCESS: Command was blocked");
	} else {
		console.error("❌ FAILURE: Command was executed despite denial");
		bashExecutions.forEach((exec, i) => {
			console.error(`  Execution ${i+1}: ${exec.args?.command}`);
			console.error(`    Timestamp: ${exec._timestamp} (${exec._timestamp - responseTime}ms after denial)`);
		});
	}
	
	// Check if there are tool_execution_end events with errors (which would indicate blocking worked)
	const bashEnds = events.filter(e => e.type === "tool_execution_end" && e.toolName === "bash");
	bashEnds.forEach((end, i) => {
		if (end.result?.error) {
			console.error(`  Execution ${i+1} ended with error: ${end.result.error}`);
		}
	});
	
	pi.kill();
	await new Promise((resolve) => pi.on("close", resolve));
	
	process.exit(bashExecutions.length > 0 ? 1 : 0);
}

runDebugTest().catch(err => {
	console.error("Test error:", err);
	process.exit(1);
});
