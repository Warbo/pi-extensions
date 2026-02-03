#!/usr/bin/env node
/**
 * Narrow down the issue by testing specific scenarios systematically
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const wrapperPath = process.env.bashPermissionWrapper;

if (!wrapperPath) {
	console.error("FATAL: bashPermissionWrapper not set");
	process.exit(1);
}

console.log("TAP version 13");
console.log("1..6");

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

function startPiWithWrapper(extensions, cwd) {
	const pi = spawn("pi", [
		"--mode", "rpc",
		"--provider", "dummy",
		"--model", "dummy-model",
		...extensions.flatMap(ext => ["--extension", ext])
	], { 
		stdio: ["pipe", "pipe", "pipe"],
		cwd
	});
	
	return pi;
}

async function waitForEvent(events, predicate, timeout = 10000) {
	const startTime = Date.now();
	return new Promise((resolve, reject) => {
		const check = () => {
			const event = events.find(predicate);
			if (event) {
				resolve(event);
			} else if (Date.now() - startTime > timeout) {
				reject(new Error("Timeout"));
			} else {
				setTimeout(check, 50);
			}
		};
		check();
	});
}

function setupEventLogging(pi) {
	const events = [];
	const readline = createInterface({ input: pi.stdout });
	readline.on("line", (line) => {
		try {
			events.push(JSON.parse(line));
		} catch (e) {}
	});
	return events;
}

// Test 1: Same as passing test (kill immediately after dialog)
async function testKillAfterDialog() {
	const tempCwd = join(tmpdir(), `pi-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(join(tempCwd, ".pi"), { recursive: true });
	writeFileSync(join(tempCwd, ".pi", "settings.json"), JSON.stringify({
		shellPath: wrapperPath
	}, null, 2));
	
	const dummyLLM = join(__dirname, "test-dummy-llm.ts");
	const bashPermission = join(__dirname, "index.ts");
	
	const pi = startPiWithWrapper([dummyLLM, bashPermission], tempCwd);
	const events = setupEventLogging(pi);
	
	await new Promise(resolve => setTimeout(resolve, 500));
	pi.stdin.write(JSON.stringify({ type: "prompt", message: "list files" }) + "\n");
	
	try {
		await waitForEvent(events, e => e.type === "extension_ui_request" && e.method === "select", 5000);
		pi.kill();
		await new Promise((resolve) => pi.on("close", resolve));
		rmSync(tempCwd, { recursive: true, force: true });
		testPass("Kill pi after permission dialog (baseline)");
	} catch (error) {
		pi.kill();
		await new Promise((resolve) => pi.on("close", resolve));
		rmSync(tempCwd, { recursive: true, force: true });
		testFail("Kill pi after permission dialog (baseline)", error.message);
	}
}

// Test 2: Send deny but DON'T wait for tool_execution_end
async function testDenyWithoutWaiting() {
	const tempCwd = join(tmpdir(), `pi-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(join(tempCwd, ".pi"), { recursive: true });
	writeFileSync(join(tempCwd, ".pi", "settings.json"), JSON.stringify({
		shellPath: wrapperPath
	}, null, 2));
	
	const dummyLLM = join(__dirname, "test-dummy-llm.ts");
	const bashPermission = join(__dirname, "index.ts");
	
	const pi = startPiWithWrapper([dummyLLM, bashPermission], tempCwd);
	const events = setupEventLogging(pi);
	
	await new Promise(resolve => setTimeout(resolve, 500));
	pi.stdin.write(JSON.stringify({ type: "prompt", message: "remove something" }) + "\n");
	
	try {
		const uiRequest = await waitForEvent(events, e => e.type === "extension_ui_request" && e.method === "select", 5000);
		pi.stdin.write(JSON.stringify({
			type: "extension_ui_response",
			id: uiRequest.id,
			value: "❌ Deny once"
		}) + "\n");
		
		// Give it a moment but don't wait for tool_execution_end
		await new Promise(resolve => setTimeout(resolve, 500));
		
		pi.kill();
		await new Promise((resolve) => pi.on("close", resolve));
		rmSync(tempCwd, { recursive: true, force: true });
		testPass("Send deny response without waiting for tool_execution_end");
	} catch (error) {
		pi.kill();
		await new Promise((resolve) => pi.on("close", resolve));
		rmSync(tempCwd, { recursive: true, force: true });
		testFail("Send deny response without waiting for tool_execution_end", error.message);
	}
}

// Test 3: Send deny AND wait for tool_execution_end (failing test)
async function testDenyAndWaitForEnd() {
	const tempCwd = join(tmpdir(), `pi-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(join(tempCwd, ".pi"), { recursive: true });
	writeFileSync(join(tempCwd, ".pi", "settings.json"), JSON.stringify({
		shellPath: wrapperPath
	}, null, 2));
	
	const dummyLLM = join(__dirname, "test-dummy-llm.ts");
	const bashPermission = join(__dirname, "index.ts");
	
	const pi = startPiWithWrapper([dummyLLM, bashPermission], tempCwd);
	const events = setupEventLogging(pi);
	
	await new Promise(resolve => setTimeout(resolve, 500));
	pi.stdin.write(JSON.stringify({ type: "prompt", message: "remove something" }) + "\n");
	
	try {
		const uiRequest = await waitForEvent(events, e => e.type === "extension_ui_request" && e.method === "select", 5000);
		console.log(`# Got dialog, sending deny...`);
		
		pi.stdin.write(JSON.stringify({
			type: "extension_ui_response",
			id: uiRequest.id,
			value: "❌ Deny once"
		}) + "\n");
		
		console.log(`# Waiting for tool_execution_end...`);
		const toolEnd = await waitForEvent(events, e => e.type === "tool_execution_end" && e.toolName === "bash", 5000);
		
		console.log(`# Got tool_execution_end: ${JSON.stringify(toolEnd)}`);
		
		pi.kill();
		await new Promise((resolve) => pi.on("close", resolve));
		rmSync(tempCwd, { recursive: true, force: true });
		testPass("Send deny response and wait for tool_execution_end");
	} catch (error) {
		console.log(`# Events with 'tool': ${JSON.stringify(events.filter(e => e.type && e.type.includes("tool")))}`);
		pi.kill();
		await new Promise((resolve) => pi.on("close", resolve));
		rmSync(tempCwd, { recursive: true, force: true });
		testFail("Send deny response and wait for tool_execution_end", error.message);
	}
}

// Test 4: Same as test 3 but with "list files" prompt instead of "remove something"
async function testDenyListFilesAndWaitForEnd() {
	const tempCwd = join(tmpdir(), `pi-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(join(tempCwd, ".pi"), { recursive: true });
	writeFileSync(join(tempCwd, ".pi", "settings.json"), JSON.stringify({
		shellPath: wrapperPath
	}, null, 2));
	
	const dummyLLM = join(__dirname, "test-dummy-llm.ts");
	const bashPermission = join(__dirname, "index.ts");
	
	const pi = startPiWithWrapper([dummyLLM, bashPermission], tempCwd);
	const events = setupEventLogging(pi);
	
	await new Promise(resolve => setTimeout(resolve, 500));
	pi.stdin.write(JSON.stringify({ type: "prompt", message: "list files" }) + "\n");
	
	try {
		const uiRequest = await waitForEvent(events, e => e.type === "extension_ui_request" && e.method === "select", 5000);
		
		pi.stdin.write(JSON.stringify({
			type: "extension_ui_response",
			id: uiRequest.id,
			value: "❌ Deny once"
		}) + "\n");
		
		const toolEnd = await waitForEvent(events, e => e.type === "tool_execution_end" && e.toolName === "bash", 5000);
		
		pi.kill();
		await new Promise((resolve) => pi.on("close", resolve));
		rmSync(tempCwd, { recursive: true, force: true });
		testPass("Deny 'list files' and wait for tool_execution_end");
	} catch (error) {
		console.log(`# Events with 'tool': ${JSON.stringify(events.filter(e => e.type && e.type.includes("tool")))}`);
		pi.kill();
		await new Promise((resolve) => pi.on("close", resolve));
		rmSync(tempCwd, { recursive: true, force: true });
		testFail("Deny 'list files' and wait for tool_execution_end", error.message);
	}
}

// Test 5: Send ALLOW instead of deny for "remove something"
async function testAllowAndWaitForEnd() {
	const tempCwd = join(tmpdir(), `pi-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(join(tempCwd, ".pi"), { recursive: true });
	writeFileSync(join(tempCwd, ".pi", "settings.json"), JSON.stringify({
		shellPath: wrapperPath
	}, null, 2));
	
	const dummyLLM = join(__dirname, "test-dummy-llm.ts");
	const bashPermission = join(__dirname, "index.ts");
	
	const pi = startPiWithWrapper([dummyLLM, bashPermission], tempCwd);
	const events = setupEventLogging(pi);
	
	await new Promise(resolve => setTimeout(resolve, 500));
	pi.stdin.write(JSON.stringify({ type: "prompt", message: "remove something" }) + "\n");
	
	try {
		const uiRequest = await waitForEvent(events, e => e.type === "extension_ui_request" && e.method === "select", 5000);
		
		pi.stdin.write(JSON.stringify({
			type: "extension_ui_response",
			id: uiRequest.id,
			value: "✅ Allow once"
		}) + "\n");
		
		const toolEnd = await waitForEvent(events, e => e.type === "tool_execution_end" && e.toolName === "bash", 5000);
		
		pi.kill();
		await new Promise((resolve) => pi.on("close", resolve));
		rmSync(tempCwd, { recursive: true, force: true });
		testPass("Allow 'remove something' and wait for tool_execution_end");
	} catch (error) {
		console.log(`# Events with 'tool': ${JSON.stringify(events.filter(e => e.type && e.type.includes("tool")))}`);
		pi.kill();
		await new Promise((resolve) => pi.on("close", resolve));
		rmSync(tempCwd, { recursive: true, force: true });
		testFail("Allow 'remove something' and wait for tool_execution_end", error.message);
	}
}

// Test 6: Without bash-permission extension (just dummy LLM)
async function testWithoutBashPermissionExtension() {
	const tempCwd = join(tmpdir(), `pi-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(join(tempCwd, ".pi"), { recursive: true });
	writeFileSync(join(tempCwd, ".pi", "settings.json"), JSON.stringify({
		shellPath: wrapperPath
	}, null, 2));
	
	const dummyLLM = join(__dirname, "test-dummy-llm.ts");
	
	const pi = startPiWithWrapper([dummyLLM], tempCwd);  // No bash-permission extension
	const events = setupEventLogging(pi);
	
	await new Promise(resolve => setTimeout(resolve, 500));
	pi.stdin.write(JSON.stringify({ type: "prompt", message: "remove something" }) + "\n");
	
	try {
		const toolEnd = await waitForEvent(events, e => e.type === "tool_execution_end" && e.toolName === "bash", 5000);
		
		pi.kill();
		await new Promise((resolve) => pi.on("close", resolve));
		rmSync(tempCwd, { recursive: true, force: true });
		testPass("Without bash-permission extension, tool_execution_end received");
	} catch (error) {
		console.log(`# Events with 'tool': ${JSON.stringify(events.filter(e => e.type && e.type.includes("tool")))}`);
		pi.kill();
		await new Promise((resolve) => pi.on("close", resolve));
		rmSync(tempCwd, { recursive: true, force: true });
		testFail("Without bash-permission extension, tool_execution_end received", error.message);
	}
}

(async function() {
	try {
		await testKillAfterDialog();
		await testDenyWithoutWaiting();
		await testDenyAndWaitForEnd();
		await testDenyListFilesAndWaitForEnd();
		await testAllowAndWaitForEnd();
		await testWithoutBashPermissionExtension();
		console.log(`# Tests: ${testNum}, Passed: ${testNum === 6 ? 6 : 'some'}, Failed: ${6 - testNum}`);
		process.exit(testNum === 6 ? 0 : 1);
	} catch (error) {
		console.log(`# FATAL: ${error.message}`);
		console.log(`# Stack: ${error.stack}`);
		process.exit(1);
	}
})();
