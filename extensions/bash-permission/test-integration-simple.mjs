#!/usr/bin/env node
/**
 * Integration tests for bash-permission extension with wrapper
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Get wrapper path from environment (set by Nix during tests)
const wrapperPath = process.env.bashPermissionWrapper;
if (!wrapperPath) {
	console.error("FATAL: bashPermissionWrapper environment variable not set");
	console.error("These tests must be run through Nix, not directly");
	process.exit(1);
}

console.log("TAP version 13");
console.log("1..2");

let testsRun = 0;
let testsPassed = 0;

function testPass(name) {
	testsRun++;
	testsPassed++;
	console.log(`ok ${testsRun} - ${name}`);
}

function testFail(name, reason) {
	testsRun++;
	console.log(`not ok ${testsRun} - ${name}`);
	if (reason) {
		console.log(`  # ${reason}`);
	}
}

// Start pi in RPC mode with wrapper configured
function startPi(extensions) {
	try {
		// Create temp working directory
		const tempCwd = join(tmpdir(), `pi-test-cwd-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(join(tempCwd, ".pi", "agent"), { recursive: true });
		
		// Create project-specific settings at $PWD/.pi/agent/settings.json
		const settings = {
			shellPath: wrapperPath,
			extensions: extensions
		};
		const settingsPath = join(tempCwd, ".pi", "agent", "settings.json");
		writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
		
		console.log(`# Created temp CWD: ${tempCwd}`);
		console.log(`# Settings: ${settingsPath}`);
		console.log(`#   Contents: ${JSON.stringify(settings)}`);
		console.log(`# Wrapper path: ${wrapperPath}`);
		console.log(`# Wrapper exists: ${existsSync(wrapperPath)}`);
		console.log(`# TMPDIR: ${process.env.TMPDIR || '/tmp'}`);
		
		const proc = spawn("pi", [
			"--mode", "rpc",
			"--provider", "dummy",
			"--model", "dummy-model",
		], { 
			stdio: ["pipe", "pipe", "pipe"],
			cwd: tempCwd
		});
		
		// Log if pi fails to start
		proc.on("error", (error) => {
			console.log(`# ERROR: Failed to spawn pi: ${error.message}`);
		});
		
		proc.on("exit", (code, signal) => {
			console.log(`# Pi process exited with code ${code}, signal ${signal}`);
		});
		
		// Clean up temp dir when process exits
		proc.on("close", () => {
			try {
				rmSync(tempCwd, { recursive: true, force: true });
			} catch (e) {
				// Ignore cleanup errors
			}
		});
		
		return proc;
	} catch (error) {
		console.log(`# FATAL: Failed to start pi: ${error.message}`);
		console.log(`# Stack: ${error.stack}`);
		throw error;
	}
}

function sendCommand(proc, cmd) {
	proc.stdin.write(JSON.stringify(cmd) + "\n");
}

async function waitForEvent(events, predicate, timeout = 10000) {
	const startTime = Date.now();
	return new Promise((resolve, reject) => {
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

// Test 1: Extension loads and intercepts bash commands
async function test1() {
	const dummyLLM = join(__dirname, "test-dummy-llm.ts");
	const bashPermission = join(__dirname, "index.ts");
	let pi;
	
	try {
		pi = startPi([dummyLLM, bashPermission]);
	} catch (error) {
		testFail("Extension intercepts bash commands and shows permission dialog", `Failed to start pi: ${error.message}`);
		return;
	}
	
	const events = [];
	const readline = createInterface({ input: pi.stdout });
	readline.on("line", (line) => {
		try {
			events.push(JSON.parse(line));
			console.log(`# Event: ${JSON.parse(line).type}`);
		} catch (e) {}
	});
	
	let stderr = "";
	let piExited = false;
	let piExitCode = null;
	
	pi.stderr.on("data", (data) => {
		const chunk = data.toString();
		stderr += chunk;
		console.log(`# pi stderr: ${chunk.trim()}`);
	});
	
	pi.on("exit", (code) => {
		piExited = true;
		piExitCode = code;
		console.log(`# Pi exited with code ${code}`);
	});
	
	try {
		// Give pi a moment to start
		await new Promise(resolve => setTimeout(resolve, 500));
		
		if (piExited) {
			throw new Error(`Pi exited immediately with code ${piExitCode}. Stderr: ${stderr}`);
		}
		
		sendCommand(pi, { type: "prompt", message: "list files" });
		
		const uiRequest = await waitForEvent(events,
			e => e.type === "extension_ui_request" && e.method === "select"
		);
		
		pi.kill();
		await new Promise((resolve) => pi.on("close", resolve));
		
		if (uiRequest.title && uiRequest.title.includes("Bash Permission")) {
			testPass("Extension intercepts bash commands and shows permission dialog");
		} else {
			testFail("Extension intercepts bash commands", `Wrong title: ${uiRequest.title}`);
		}
	} catch (error) {
		if (pi && !piExited) pi.kill();
		await new Promise((resolve) => setTimeout(resolve, 100));
		testFail("Extension intercepts bash commands", error.message);
	}
}

// Test 2: Denied command is blocked by wrapper
async function test2() {
	const dummyLLM = join(__dirname, "test-dummy-llm.ts");
	const bashPermission = join(__dirname, "index.ts");
	let pi;
	
	try {
		pi = startPi([dummyLLM, bashPermission]);
	} catch (error) {
		testFail("Denied command is blocked by wrapper", `Failed to start pi: ${error.message}`);
		return;
	}
	
	const events = [];
	const readline = createInterface({ input: pi.stdout });
	readline.on("line", (line) => {
		try {
			const event = JSON.parse(line);
			event._timestamp = Date.now();
			events.push(event);
			// Log all events for debugging
			if (event.type === "tool_execution_start" || 
			    event.type === "tool_execution_end" ||
			    event.type === "extension_ui_request") {
				console.log(`# Event: ${event.type} ${event.toolName || event.method || ''}`);
			}
		} catch (e) {}
	});
	
	let stderr = "";
	let piExited = false;
	let piExitCode = null;
	
	pi.stderr.on("data", (data) => {
		const chunk = data.toString();
		stderr += chunk;
		// Log stderr lines
		chunk.split('\n').forEach(line => {
			if (line.trim()) {
				console.log(`# pi stderr: ${line}`);
			}
		});
	});
	
	pi.on("exit", (code) => {
		piExited = true;
		piExitCode = code;
	});
	
	try {
		// Give pi a moment to start
		await new Promise(resolve => setTimeout(resolve, 500));
		
		if (piExited) {
			throw new Error(`Pi exited immediately with code ${piExitCode}. Stderr: ${stderr}`);
		}
		
		// Ask agent to remove a file (must match dummy LLM canned response)
		sendCommand(pi, { type: "prompt", message: "remove something" });
		
		// Wait for permission dialog
		console.log("# Waiting for permission dialog...");
		const uiRequest = await waitForEvent(events,
			e => e.type === "extension_ui_request" && e.method === "select",
			10000
		);
		console.log("# Got permission dialog");
		
		// User denies the command
		sendCommand(pi, {
			type: "extension_ui_response",
			id: uiRequest.id,
			value: "❌ Deny once"
		});
		console.log("# Sent deny response");
		
		// Wait for tool execution to complete
		console.log("# Waiting for tool execution to complete...");
		const toolResult = await waitForEvent(events,
			e => e.type === "tool_execution_end" && e.toolName === "bash",
			10000
		);
		console.log(`# Got tool result: ${JSON.stringify(toolResult)}`);
		
		pi.kill();
		await new Promise((resolve) => pi.on("close", resolve));
		
		// With wrapper: command should fail with error from wrapper
		const hasError = toolResult.result?.error || 
		                 toolResult.result?.exitCode === 1 ||
		                 (stderr.includes("bash-permission") && stderr.includes("denied"));
		
		if (hasError) {
			testPass("Denied command is blocked by wrapper");
		} else {
			testFail("Denied command is blocked by wrapper",
				`Command executed without error. Result: ${JSON.stringify(toolResult.result)}`);
		}
	} catch (error) {
		if (pi && !piExited) pi.kill();
		await new Promise((resolve) => setTimeout(resolve, 100));
		testFail("Denied command is blocked by wrapper", error.message);
	}
}

// Run tests with global error handling
(async function() {
	try {
		await test1();
	} catch (error) {
		console.log(`# FATAL ERROR in test1: ${error.message}`);
		console.log(`# Stack: ${error.stack}`);
		testFail("Extension intercepts bash commands and shows permission dialog", `FATAL: ${error.message}`);
	}
	
	try {
		await test2();
	} catch (error) {
		console.log(`# FATAL ERROR in test2: ${error.message}`);
		console.log(`# Stack: ${error.stack}`);
		testFail("Denied command is blocked by wrapper", `FATAL: ${error.message}`);
	}
	
	console.log(`# Tests: ${testsRun}, Passed: ${testsPassed}, Failed: ${testsRun - testsPassed}`);
	process.exit(testsPassed === testsRun ? 0 : 1);
})().catch((error) => {
	console.log(`# CATASTROPHIC ERROR: ${error.message}`);
	console.log(`# Stack: ${error.stack}`);
	// Ensure we've written at least some test results
	while (testsRun < 2) {
		testFail(`Test ${testsRun + 1}`, `CATASTROPHIC ERROR: ${error.message}`);
	}
	console.log(`# Tests: ${testsRun}, Passed: ${testsPassed}, Failed: ${testsRun - testsPassed}`);
	process.exit(1);
});
