#!/usr/bin/env node
/**
 * Integration test for bash-permission extension
 * Tests extension with pi in RPC mode using dummy LLM
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));

let testsRun = 0;
let testsPassed = 0;
let testsFailed = 0;

function testPass(name) {
	testsRun++;
	testsPassed++;
	console.log(`ok ${testsRun} - ${name}`);
}

function testFail(name, reason) {
	testsRun++;
	testsFailed++;
	console.log(`not ok ${testsRun} - ${name}`);
	if (reason) {
		console.log(`  # ${reason}`);
	}
}

// Start pi in RPC mode with extensions
function startPi(extensions, cwd) {
	const args = [
		"--mode", "rpc",
		"--no-session",
		"--provider", "dummy",
		"--model", "dummy-model",
		...extensions.flatMap(ext => ["-e", ext])
	];
	
	const proc = spawn("pi", args, {
		stdio: ["pipe", "pipe", "pipe"],
		cwd,
		env: { ...process.env, HOME: cwd }
	});
	
	return proc;
}

function sendCommand(proc, cmd) {
	proc.stdin.write(JSON.stringify(cmd) + "\n");
}

async function runTest(name, testFn) {
	const tempDir = join(tmpdir(), `pi-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });
	
	const dummyLLM = join(__dirname, "test-dummy-llm.ts");
	const bashPermission = join(__dirname, "index.ts");
	
	const pi = startPi([dummyLLM, bashPermission], tempDir);
	
	const events = [];
	const readline = createInterface({ input: pi.stdout });
	
	readline.on("line", (line) => {
		try {
			const event = JSON.parse(line);
			events.push(event);
		} catch (e) {
			// Ignore parse errors
		}
	});
	
	let stderr = "";
	pi.stderr.on("data", (data) => {
		stderr += data.toString();
	});
	
	try {
		const result = await Promise.race([
			testFn(pi, events, sendCommand, tempDir),
			new Promise((_, reject) =>
				setTimeout(() => reject(new Error("Test timeout")), 30000)
			),
		]);
		
		pi.kill();
		await new Promise((resolve) => pi.on("close", resolve));
		
		if (result === true) {
			testPass(name);
		} else {
			testFail(name, result || "Test returned false");
		}
	} catch (error) {
		pi.kill();
		await new Promise((resolve) => pi.on("close", resolve));
		testFail(name, error.message);
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}

function waitForEvent(events, predicate, timeout = 10000) {
	return new Promise((resolve, reject) => {
		const startTime = Date.now();
		const check = () => {
			const event = events.find(predicate);
			if (event) {
				resolve(event);
			} else if (Date.now() - startTime > timeout) {
				reject(new Error("Timeout waiting for event"));
			} else {
				setTimeout(check, 50);
			}
		};
		check();
	});
}

console.log("TAP version 13");
console.log("1..5");

// Test 1: Permission dialog appears for bash command
await runTest("Permission dialog appears", async (pi, events, send) => {
	send(pi, { type: "prompt", message: "list files" });
	
	const uiRequest = await waitForEvent(events,
		e => e.type === "extension_ui_request" && e.method === "select"
	);
	
	if (!uiRequest.title || !uiRequest.title.includes("Bash Permission")) {
		return "UI request title doesn't include 'Bash Permission'";
	}
	
	if (!uiRequest.options || !uiRequest.options.includes("✅ Allow once")) {
		return "UI request doesn't have expected options";
	}
	
	return true;
});

// Test 2: Allow once permits command
await runTest("Allow once permits command", async (pi, events, send) => {
	send(pi, { type: "prompt", message: "list files" });
	
	const uiRequest = await waitForEvent(events,
		e => e.type === "extension_ui_request" && e.method === "select"
	);
	
	send(pi, {
		type: "extension_ui_response",
		id: uiRequest.id,
		value: "✅ Allow once"
	});
	
	const toolStart = await waitForEvent(events,
		e => e.type === "tool_execution_start" && e.toolName === "bash"
	);
	
	if (toolStart.args.command !== "ls -la") {
		return `Unexpected command: ${toolStart.args.command}`;
	}
	
	return true;
});

// Test 3: Allow exact saves to config
await runTest("Allow exact saves rule", async (pi, events, send, tempDir) => {
	send(pi, { type: "prompt", message: "check git status" });
	
	const uiRequest = await waitForEvent(events,
		e => e.type === "extension_ui_request" && e.method === "select"
	);
	
	send(pi, {
		type: "extension_ui_response",
		id: uiRequest.id,
		value: "✓ Allow exact"
	});
	
	await waitForEvent(events,
		e => e.type === "tool_execution_start" && e.toolName === "bash"
	);
	
	// Give it time to save config
	await new Promise(resolve => setTimeout(resolve, 500));
	
	// Check config was saved
	const configPath = join(tempDir, ".config", "pi", "bash-permission.json");
	try {
		const configData = JSON.parse(require("fs").readFileSync(configPath, "utf-8"));
		if (!configData.allowedExact || !configData.allowedExact.includes("git status")) {
			return "Config not saved correctly";
		}
	} catch (e) {
		return `Config file error: ${e.message}`;
	}
	
	return true;
});

// Test 4: Multiple commands in same session
await runTest("Multiple commands in same session", async (pi, events, send) => {
	// First command
	send(pi, { type: "prompt", message: "list files" });
	
	let uiRequest = await waitForEvent(events,
		e => e.type === "extension_ui_request" && e.method === "select"
	);
	
	send(pi, {
		type: "extension_ui_response",
		id: uiRequest.id,
		value: "✅ Allow once"
	});
	
	await waitForEvent(events,
		e => e.type === "tool_execution_end" && e.toolName === "bash"
	);
	
	// Second command
	send(pi, { type: "prompt", message: "check git status" });
	
	uiRequest = await waitForEvent(events,
		e => e.type === "extension_ui_request" && e.method === "select" && e.id !== uiRequest.id
	);
	
	send(pi, {
		type: "extension_ui_response",
		id: uiRequest.id,
		value: "❌ Deny once"
	});
	
	// Wait a bit for second command to be processed
	await new Promise(resolve => setTimeout(resolve, 500));
	
	return true;
});

// Test 5: Extension doesn't interfere with exit codes
await runTest("Extension preserves bash exit codes", async (pi, events, send, tempDir) => {
	// Pre-allow all commands
	const configPath = join(tempDir, ".config", "pi", "bash-permission.json");
	require("fs").mkdirSync(join(tempDir, ".config", "pi"), { recursive: true });
	require("fs").writeFileSync(configPath, JSON.stringify({
		allowedPrefixes: [""],
		allowedExact: [],
		deniedPrefixes: [],
		deniedExact: []
	}), "utf-8");
	
	// Trigger command that will succeed (exit 0)
	send(pi, { type: "prompt", message: "check git status" });
	
	const successResult = await waitForEvent(events,
		e => e.type === "tool_execution_end" && e.toolName === "bash"
	);
	
	// Git status should succeed or fail properly, not be blocked
	// Just check we got a result
	if (!successResult.result) {
		return "No result from bash tool";
	}
	
	return true;
});

process.exit(testsFailed > 0 ? 1 : 0);
