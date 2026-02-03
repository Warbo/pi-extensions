#!/usr/bin/env node
/**
 * Test: Does pi send tool_execution_end for commands that exit with non-zero codes?
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const wrapperPath = process.env.bashPermissionWrapper;
if (!wrapperPath) {
	console.error("FATAL: bashPermissionWrapper not set");
	process.exit(1);
}

console.log("TAP version 13");
console.log("1..2");

let testNum = 0;

function testPass(name) {
	testNum++;
	console.log(`ok ${testNum} - ${name}`);
}

function testFail(name, reason) {
	testNum++;
	console.log(`not ok ${testNum} - ${name}`);
	if (reason) console.log(`  # ${reason}`);
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

async function testBashExitCodeZero() {
	console.log("# Test: tool_execution_end sent for exit code 0");
	
	const tempCwd = join(tmpdir(), `pi-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempCwd, { recursive: true });
	
	// Use bash directly (not wrapper) to test pi's behavior
	const dummyLLM = join(process.cwd(), "test-dummy-llm.ts");
	
	const pi = spawn("pi", [
		"--mode", "rpc",
		"--provider", "dummy",
		"--model", "dummy-model",
		"--extension", dummyLLM
	], {
		stdio: ["pipe", "pipe", "pipe"],
		cwd: tempCwd
	});
	
	const events = [];
	const readline = createInterface({ input: pi.stdout });
	readline.on("line", (line) => {
		try {
			const event = JSON.parse(line);
			events.push(event);
			if (event.type && event.type.includes("tool")) {
				console.log(`# Event: ${event.type} ${event.toolName || ''}`);
			}
		} catch (e) {}
	});
	
	await new Promise(resolve => setTimeout(resolve, 1000));
	
	// Send command that will succeed (exit 0)
	pi.stdin.write(JSON.stringify({ type: "prompt", message: "list files" }) + "\n");
	
	try {
		const toolEnd = await waitForEvent(events,
			e => e.type === "tool_execution_end" && e.toolName === "bash",
			5000
		);
		
		pi.kill();
		await new Promise((resolve) => pi.on("close", resolve));
		rmSync(tempCwd, { recursive: true, force: true });
		
		testPass("tool_execution_end sent for exit code 0");
	} catch (error) {
		pi.kill();
		await new Promise((resolve) => pi.on("close", resolve));
		rmSync(tempCwd, { recursive: true, force: true });
		
		console.log(`# Events: ${JSON.stringify(events.filter(e => e.type && e.type.includes("tool")))}`);
		testFail("tool_execution_end sent for exit code 0", error.message);
	}
}

async function testBashExitCodeOne() {
	console.log("# Test: tool_execution_end sent for exit code 1");
	
	const tempCwd = join(tmpdir(), `pi-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(join(tempCwd, ".pi"), { recursive: true });
	
	// Create a wrapper that ALWAYS exits with code 1
	const failWrapper = join(tempCwd, "fail-wrapper.sh");
	writeFileSync(failWrapper, `#!/bin/bash
echo "Wrapper: denying command" >&2
exit 1
`, { mode: 0o755 });
	
	writeFileSync(join(tempCwd, ".pi", "settings.json"), JSON.stringify({
		shellPath: failWrapper
	}, null, 2));
	
	const dummyLLM = join(process.cwd(), "test-dummy-llm.ts");
	
	const pi = spawn("pi", [
		"--mode", "rpc",
		"--provider", "dummy",
		"--model", "dummy-model",
		"--extension", dummyLLM
	], {
		stdio: ["pipe", "pipe", "pipe"],
		cwd: tempCwd
	});
	
	const events = [];
	const readline = createInterface({ input: pi.stdout });
	readline.on("line", (line) => {
		try {
			const event = JSON.parse(line);
			events.push(event);
			if (event.type && event.type.includes("tool")) {
				console.log(`# Event: ${event.type} ${event.toolName || ''} isError=${event.isError}`);
			}
		} catch (e) {}
	});
	
	let stderr = "";
	pi.stderr.on("data", (data) => {
		stderr += data.toString();
	});
	
	await new Promise(resolve => setTimeout(resolve, 1000));
	
	// Send command that will fail (exit 1)
	pi.stdin.write(JSON.stringify({ type: "prompt", message: "list files" }) + "\n");
	
	try {
		const toolEnd = await waitForEvent(events,
			e => e.type === "tool_execution_end" && e.toolName === "bash",
			5000
		);
		
		pi.kill();
		await new Promise((resolve) => pi.on("close", resolve));
		rmSync(tempCwd, { recursive: true, force: true });
		
		console.log(`# tool_execution_end.isError: ${toolEnd.isError}`);
		console.log(`# tool_execution_end.result: ${JSON.stringify(toolEnd.result)}`);
		testPass("tool_execution_end sent for exit code 1");
	} catch (error) {
		pi.kill();
		await new Promise((resolve) => pi.on("close", resolve));
		rmSync(tempCwd, { recursive: true, force: true });
		
		console.log(`# stderr: ${stderr.substring(0, 200)}`);
		console.log(`# Events: ${JSON.stringify(events.filter(e => e.type && e.type.includes("tool")))}`);
		testFail("tool_execution_end sent for exit code 1", error.message);
	}
}

(async function() {
	try {
		await testBashExitCodeZero();
		await testBashExitCodeOne();
		process.exit(testNum === 2 ? 0 : 1);
	} catch (error) {
		console.log(`# FATAL: ${error.message}`);
		process.exit(1);
	}
})();
