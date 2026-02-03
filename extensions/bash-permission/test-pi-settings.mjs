#!/usr/bin/env node
/**
 * Tests to verify pi's settings loading behavior
 * Understand WHEN and HOW pi reads settings.json
 */

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const wrapperPath = process.env.bashPermissionWrapper;
if (!wrapperPath) {
	console.error("FATAL: bashPermissionWrapper environment variable not set");
	process.exit(1);
}

console.log("TAP version 13");
console.log("1..9");

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

async function runPi(args, cwd, env = {}) {
	const pi = spawn("pi", args, {
		stdio: ["pipe", "pipe", "pipe"],
		cwd: cwd,
		env: { ...process.env, ...env }
	});
	
	let stdout = "";
	let stderr = "";
	pi.stdout.on("data", (data) => {
		stdout += data.toString();
	});
	pi.stderr.on("data", (data) => {
		stderr += data.toString();
	});
	
	await new Promise((resolve) => {
		pi.on("exit", () => resolve());
		setTimeout(() => {
			if (pi.exitCode === null) pi.kill();
		}, 2000);
	});
	
	return { stdout, stderr, exitCode: pi.exitCode };
}

function checkWrapperInvoked() {
	const tempDir = process.env.TMPDIR || "/tmp";
	const files = readdirSync(tempDir);
	const wrapperLogs = files.filter(f => f.startsWith("bash-permission-wrapper-"));
	return wrapperLogs.length;
}

async function testInvalidShellPathInProjectSettingsNoArgs() {
	const tempCwd = join(tmpdir(), `pi-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(join(tempCwd, ".pi"), { recursive: true });
	
	writeFileSync(join(tempCwd, ".pi", "settings.json"), JSON.stringify({
		shellPath: "/nonexistent/shell/binary"
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
	
	let stdout = "";
	pi.stdout.on("data", (data) => {
		stdout += data.toString();
	});
	
	await new Promise(resolve => setTimeout(resolve, 1000));
	// Send prompt that triggers LLM to generate bash command
	pi.stdin.write(JSON.stringify({ type: "prompt", message: "list files" }) + "\n");
	await new Promise(resolve => setTimeout(resolve, 2000));
	pi.kill();
	await new Promise((resolve) => pi.on("close", resolve));
	
	rmSync(tempCwd, { recursive: true, force: true });
	
	// Check for tool_execution_end event with isError: true
	const hasToolError = stdout.split('\n').some(line => {
		try {
			const event = JSON.parse(line);
			return event.type === "tool_execution_end" && event.isError === true &&
			       (JSON.stringify(event).includes("shell path not found") || 
			        JSON.stringify(event).includes("/nonexistent/shell"));
		} catch { return false; }
	});
	
	if (hasToolError) {
		testPass("Invalid shellPath in project settings causes error (with dummy provider)");
	} else {
		testFail("Invalid shellPath in project settings causes error (with dummy provider)", 
			`No tool error found in RPC events. Stdout: ${stdout.substring(0, 200)}`);
	}
}

async function testInvalidShellPathInProjectSettingsWithModeArg() {
	const tempCwd = join(tmpdir(), `pi-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(join(tempCwd, ".pi"), { recursive: true });
	
	writeFileSync(join(tempCwd, ".pi", "settings.json"), JSON.stringify({
		shellPath: "/nonexistent/shell/binary"
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
	
	let stdout = "";
	pi.stdout.on("data", (data) => {
		stdout += data.toString();
	});
	
	await new Promise(resolve => setTimeout(resolve, 1000));
	// Send prompt that triggers LLM to generate bash command
	pi.stdin.write(JSON.stringify({ type: "prompt", message: "list files" }) + "\n");
	await new Promise(resolve => setTimeout(resolve, 2000));
	pi.kill();
	await new Promise((resolve) => pi.on("close", resolve));
	
	rmSync(tempCwd, { recursive: true, force: true });
	
	// Check for tool_execution_end event with isError: true
	const hasToolError = stdout.split('\n').some(line => {
		try {
			const event = JSON.parse(line);
			return event.type === "tool_execution_end" && event.isError === true &&
			       (JSON.stringify(event).includes("shell path not found") || 
			        JSON.stringify(event).includes("/nonexistent/shell"));
		} catch { return false; }
	});
	
	if (hasToolError) {
		testPass("Invalid shellPath in project settings causes error (with --mode rpc)");
	} else {
		testFail("Invalid shellPath in project settings causes error (with --mode rpc)", 
			`No tool error found in RPC events. Stdout: ${stdout.substring(0, 200)}`);
	}
}

async function testInvalidShellPathInProjectSettingsWithProviderArgs() {
	const tempCwd = join(tmpdir(), `pi-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(join(tempCwd, ".pi"), { recursive: true });
	
	writeFileSync(join(tempCwd, ".pi", "settings.json"), JSON.stringify({
		shellPath: "/nonexistent/shell/binary"
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
	
	let stdout = "";
	pi.stdout.on("data", (data) => {
		stdout += data.toString();
	});
	
	await new Promise(resolve => setTimeout(resolve, 1000));
	// Send prompt that triggers LLM to generate bash command
	pi.stdin.write(JSON.stringify({ type: "prompt", message: "list files" }) + "\n");
	await new Promise(resolve => setTimeout(resolve, 2000));
	pi.kill();
	await new Promise((resolve) => pi.on("close", resolve));
	
	rmSync(tempCwd, { recursive: true, force: true });
	
	// Check for tool_execution_end event with isError: true
	const hasToolError = stdout.split('\n').some(line => {
		try {
			const event = JSON.parse(line);
			return event.type === "tool_execution_end" && event.isError === true &&
			       (JSON.stringify(event).includes("shell path not found") || 
			        JSON.stringify(event).includes("/nonexistent/shell"));
		} catch { return false; }
	});
	
	if (hasToolError) {
		testPass("Invalid shellPath in project settings causes error (with --provider and --model)");
	} else {
		testFail("Invalid shellPath in project settings causes error (with --provider and --model)", 
			`No tool error found in RPC events. Stdout: ${stdout.substring(0, 200)}`);
	}
}

async function testInvalidShellPathInGlobalSettings() {
	const tempHome = join(tmpdir(), `pi-home-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const tempCwd = join(tmpdir(), `pi-cwd-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(join(tempHome, ".pi", "agent"), { recursive: true });
	mkdirSync(tempCwd, { recursive: true });
	
	writeFileSync(join(tempHome, ".pi", "agent", "settings.json"), JSON.stringify({
		shellPath: "/another/nonexistent/shell"
	}, null, 2));
	
	const dummyLLM = join(process.cwd(), "test-dummy-llm.ts");
	
	const pi = spawn("pi", [
		"--mode", "rpc",
		"--provider", "dummy",
		"--model", "dummy-model",
		"--extension", dummyLLM
	], {
		stdio: ["pipe", "pipe", "pipe"],
		cwd: tempCwd,
		env: { ...process.env, HOME: tempHome }
	});
	
	let stdout = "";
	pi.stdout.on("data", (data) => {
		stdout += data.toString();
	});
	
	await new Promise(resolve => setTimeout(resolve, 1000));
	// Send prompt that triggers LLM to generate bash command
	pi.stdin.write(JSON.stringify({ type: "prompt", message: "list files" }) + "\n");
	await new Promise(resolve => setTimeout(resolve, 2000));
	pi.kill();
	await new Promise((resolve) => pi.on("close", resolve));
	
	rmSync(tempHome, { recursive: true, force: true });
	rmSync(tempCwd, { recursive: true, force: true });
	
	// Check for tool_execution_end event with isError: true
	const hasToolError = stdout.split('\n').some(line => {
		try {
			const event = JSON.parse(line);
			return event.type === "tool_execution_end" && event.isError === true &&
			       (JSON.stringify(event).includes("shell path not found") || 
			        JSON.stringify(event).includes("/another/nonexistent"));
		} catch { return false; }
	});
	
	if (hasToolError) {
		testPass("Invalid shellPath in global settings causes error");
	} else {
		testFail("Invalid shellPath in global settings causes error",
			`No tool error found in RPC events. Stdout: ${stdout.substring(0, 200)}`);
	}
}

async function testValidShellPathWithDummyProvider() {
	const tempCwd = join(tmpdir(), `pi-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(join(tempCwd, ".pi"), { recursive: true });
	
	writeFileSync(join(tempCwd, ".pi", "settings.json"), JSON.stringify({
		shellPath: wrapperPath
	}, null, 2));
	
	const dummyLLM = join(process.cwd(), "test-dummy-llm.ts");
	
	const beforeCount = checkWrapperInvoked();
	
	const pi = spawn("pi", [
		"--mode", "rpc",
		"--provider", "dummy",
		"--model", "dummy-model",
		"--extension", dummyLLM
	], {
		stdio: ["pipe", "pipe", "pipe"],
		cwd: tempCwd
	});
	
	await new Promise(resolve => setTimeout(resolve, 1000));
	pi.stdin.write(JSON.stringify({ type: "prompt", message: "list files" }) + "\n");
	await new Promise(resolve => setTimeout(resolve, 2000));
	pi.kill();
	await new Promise((resolve) => pi.on("close", resolve));
	
	const afterCount = checkWrapperInvoked();
	
	rmSync(tempCwd, { recursive: true, force: true });
	
	if (afterCount > beforeCount) {
		testPass("Valid shellPath causes wrapper invocation (with --provider dummy)");
	} else {
		testFail("Valid shellPath causes wrapper invocation (with --provider dummy)",
			`No new wrapper logs. Before: ${beforeCount}, After: ${afterCount}`);
	}
}



async function testPiCodingAgentDirEnvVar() {
	const tempAgentDir = join(tmpdir(), `pi-agent-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const tempCwd = join(tmpdir(), `pi-cwd-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempAgentDir, { recursive: true });
	mkdirSync(tempCwd, { recursive: true });
	
	writeFileSync(join(tempAgentDir, "settings.json"), JSON.stringify({
		shellPath: "/yet/another/fake/shell"
	}, null, 2));
	
	const dummyLLM = join(process.cwd(), "test-dummy-llm.ts");
	
	const pi = spawn("pi", [
		"--mode", "rpc",
		"--provider", "dummy",
		"--model", "dummy-model",
		"--extension", dummyLLM
	], {
		stdio: ["pipe", "pipe", "pipe"],
		cwd: tempCwd,
		env: { ...process.env, PI_CODING_AGENT_DIR: tempAgentDir }
	});
	
	let stdout = "";
	pi.stdout.on("data", (data) => {
		stdout += data.toString();
	});
	
	await new Promise(resolve => setTimeout(resolve, 1000));
	// Send prompt that triggers LLM to generate bash command
	pi.stdin.write(JSON.stringify({ type: "prompt", message: "list files" }) + "\n");
	await new Promise(resolve => setTimeout(resolve, 2000));
	pi.kill();
	await new Promise((resolve) => pi.on("close", resolve));
	
	rmSync(tempAgentDir, { recursive: true, force: true });
	rmSync(tempCwd, { recursive: true, force: true });
	
	// Check for tool_execution_end event with isError: true
	const hasToolError = stdout.split('\n').some(line => {
		try {
			const event = JSON.parse(line);
			return event.type === "tool_execution_end" && event.isError === true &&
			       (JSON.stringify(event).includes("shell path not found") || 
			        JSON.stringify(event).includes("/yet/another/fake"));
		} catch { return false; }
	});
	
	if (hasToolError) {
		testPass("PI_CODING_AGENT_DIR environment variable is respected");
	} else {
		testFail("PI_CODING_AGENT_DIR environment variable is respected",
			`No tool error found in RPC events. Stdout: ${stdout.substring(0, 200)}`);
	}
}

async function testProjectSettingsOverrideGlobalSettings() {
	const tempHome = join(tmpdir(), `pi-home-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const tempCwd = join(tmpdir(), `pi-cwd-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(join(tempHome, ".pi", "agent"), { recursive: true });
	mkdirSync(join(tempCwd, ".pi"), { recursive: true });
	
	writeFileSync(join(tempHome, ".pi", "agent", "settings.json"), JSON.stringify({
		shellPath: wrapperPath
	}, null, 2));
	
	writeFileSync(join(tempCwd, ".pi", "settings.json"), JSON.stringify({
		shellPath: "/project/override/shell"
	}, null, 2));
	
	const dummyLLM = join(process.cwd(), "test-dummy-llm.ts");
	
	const pi = spawn("pi", [
		"--mode", "rpc",
		"--provider", "dummy",
		"--model", "dummy-model",
		"--extension", dummyLLM
	], {
		stdio: ["pipe", "pipe", "pipe"],
		cwd: tempCwd,
		env: { ...process.env, HOME: tempHome }
	});
	
	let stdout = "";
	pi.stdout.on("data", (data) => {
		stdout += data.toString();
	});
	
	await new Promise(resolve => setTimeout(resolve, 1000));
	// Send prompt that triggers LLM to generate bash command
	pi.stdin.write(JSON.stringify({ type: "prompt", message: "list files" }) + "\n");
	await new Promise(resolve => setTimeout(resolve, 2000));
	pi.kill();
	await new Promise((resolve) => pi.on("close", resolve));
	
	rmSync(tempHome, { recursive: true, force: true });
	rmSync(tempCwd, { recursive: true, force: true });
	
	// Check for tool_execution_end event with isError: true mentioning project path
	const hasToolError = stdout.split('\n').some(line => {
		try {
			const event = JSON.parse(line);
			return event.type === "tool_execution_end" && event.isError === true &&
			       JSON.stringify(event).includes("/project/override/shell");
		} catch { return false; }
	});
	
	if (hasToolError) {
		testPass("Project settings override global settings for shellPath");
	} else {
		testFail("Project settings override global settings for shellPath",
			`Error doesn't mention project path. Stdout: ${stdout.substring(0, 200)}`);
	}
}

async function testMultipleCommandsSamePiInstance() {
	const tempCwd = join(tmpdir(), `pi-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(join(tempCwd, ".pi"), { recursive: true });
	
	writeFileSync(join(tempCwd, ".pi", "settings.json"), JSON.stringify({
		shellPath: wrapperPath
	}, null, 2));
	
	const dummyLLM = join(process.cwd(), "test-dummy-llm.ts");
	
	const beforeCount = checkWrapperInvoked();
	
	const pi = spawn("pi", [
		"--mode", "rpc",
		"--provider", "dummy",
		"--model", "dummy-model",
		"--extension", dummyLLM
	], {
		stdio: ["pipe", "pipe", "pipe"],
		cwd: tempCwd
	});
	
	await new Promise(resolve => setTimeout(resolve, 1000));
	
	// Send first command (ls)
	pi.stdin.write(JSON.stringify({ type: "prompt", message: "list files" }) + "\n");
	await new Promise(resolve => setTimeout(resolve, 2000));
	
	// Send second command (rm)
	pi.stdin.write(JSON.stringify({ type: "prompt", message: "remove something" }) + "\n");
	await new Promise(resolve => setTimeout(resolve, 2000));
	
	pi.kill();
	await new Promise((resolve) => pi.on("close", resolve));
	
	const afterCount = checkWrapperInvoked();
	const invokedCount = afterCount - beforeCount;
	
	rmSync(tempCwd, { recursive: true, force: true });
	
	if (invokedCount >= 2) {
		testPass("Multiple commands in same pi instance both invoke wrapper");
	} else {
		testFail("Multiple commands in same pi instance both invoke wrapper",
			`Only ${invokedCount} invocations. Expected 2+`);
	}
}

async function testSameCommandDifferentPiInstances() {
	const beforeCount = checkWrapperInvoked();
	
	// First pi instance
	const tempCwd1 = join(tmpdir(), `pi-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(join(tempCwd1, ".pi"), { recursive: true });
	writeFileSync(join(tempCwd1, ".pi", "settings.json"), JSON.stringify({
		shellPath: wrapperPath
	}, null, 2));
	
	const dummyLLM = join(process.cwd(), "test-dummy-llm.ts");
	
	const pi1 = spawn("pi", [
		"--mode", "rpc",
		"--provider", "dummy",
		"--model", "dummy-model",
		"--extension", dummyLLM
	], {
		stdio: ["pipe", "pipe", "pipe"],
		cwd: tempCwd1
	});
	
	await new Promise(resolve => setTimeout(resolve, 1000));
	pi1.stdin.write(JSON.stringify({ type: "prompt", message: "list files" }) + "\n");
	await new Promise(resolve => setTimeout(resolve, 2000));
	pi1.kill();
	await new Promise((resolve) => pi1.on("close", resolve));
	
	const afterFirst = checkWrapperInvoked();
	
	// Second pi instance (same command)
	const tempCwd2 = join(tmpdir(), `pi-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(join(tempCwd2, ".pi"), { recursive: true });
	writeFileSync(join(tempCwd2, ".pi", "settings.json"), JSON.stringify({
		shellPath: wrapperPath
	}, null, 2));
	
	const pi2 = spawn("pi", [
		"--mode", "rpc",
		"--provider", "dummy",
		"--model", "dummy-model",
		"--extension", dummyLLM
	], {
		stdio: ["pipe", "pipe", "pipe"],
		cwd: tempCwd2
	});
	
	await new Promise(resolve => setTimeout(resolve, 1000));
	pi2.stdin.write(JSON.stringify({ type: "prompt", message: "list files" }) + "\n");
	await new Promise(resolve => setTimeout(resolve, 2000));
	pi2.kill();
	await new Promise((resolve) => pi2.on("close", resolve));
	
	const afterSecond = checkWrapperInvoked();
	
	rmSync(tempCwd1, { recursive: true, force: true });
	rmSync(tempCwd2, { recursive: true, force: true });
	
	const firstInvocations = afterFirst - beforeCount;
	const secondInvocations = afterSecond - afterFirst;
	
	if (firstInvocations >= 1 && secondInvocations >= 1) {
		testPass("Same command in different pi instances both invoke wrapper");
	} else {
		testFail("Same command in different pi instances both invoke wrapper",
			`First: ${firstInvocations}, Second: ${secondInvocations}. Expected 1+, 1+`);
	}
}

// Run all tests
(async function() {
	try {
		await testInvalidShellPathInProjectSettingsNoArgs();
		await testInvalidShellPathInProjectSettingsWithModeArg();
		await testInvalidShellPathInProjectSettingsWithProviderArgs();
		await testInvalidShellPathInGlobalSettings();
		await testValidShellPathWithDummyProvider();
		await testPiCodingAgentDirEnvVar();
		await testProjectSettingsOverrideGlobalSettings();
		await testMultipleCommandsSamePiInstance();
		await testSameCommandDifferentPiInstances();
		process.exit(0);
	} catch (error) {
		console.log(`# FATAL: ${error.message}`);
		console.log(`# Stack: ${error.stack}`);
		process.exit(1);
	}
})();
