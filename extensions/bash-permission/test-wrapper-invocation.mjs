#!/usr/bin/env node
/**
 * Direct test: Does the wrapper get invoked for "rm -rf test.txt"?
 */

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const wrapperPath = process.env.bashPermissionWrapper;
if (!wrapperPath) {
	console.error("FATAL: bashPermissionWrapper not set");
	process.exit(1);
}

console.log("TAP version 13");
console.log("1..1");

function countWrapperLogsMatching(pattern) {
	const tempDir = process.env.TMPDIR || "/tmp";
	const files = readdirSync(tempDir);
	let count = 0;
	for (const file of files) {
		if (!file.startsWith("bash-permission-wrapper-")) continue;
		try {
			const content = readFileSync(join(tempDir, file), "utf-8");
			if (content.includes(pattern)) count++;
		} catch (error) {
			console.log(`# Warning: Failed to read ${file}: ${error.message}`);
		}
	}
	return count;
}

async function testWrapperInvokedForRmCommand() {
	// Clean up old logs
	const tempDir = process.env.TMPDIR || "/tmp";
	const files = readdirSync(tempDir);
	for (const file of files) {
		if (file.startsWith("bash-permission-wrapper-")) {
			rmSync(join(tempDir, file), { force: true });
		}
	}
	
	const tempCwd = join(tmpdir(), `pi-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(join(tempCwd, ".pi"), { recursive: true });
	
	writeFileSync(join(tempCwd, ".pi", "settings.json"), JSON.stringify({
		shellPath: wrapperPath
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
	
	await new Promise(resolve => setTimeout(resolve, 1000));
	
	// Send command that triggers "rm -rf test.txt"
	pi.stdin.write(JSON.stringify({ type: "prompt", message: "remove something" }) + "\n");
	
	await new Promise(resolve => setTimeout(resolve, 3000));
	
	pi.kill();
	await new Promise((resolve) => pi.on("close", resolve));
	
	// Count wrapper logs mentioning "rm"
	const rmLogs = countWrapperLogsMatching("rm -rf");
	
	rmSync(tempCwd, { recursive: true, force: true });
	
	if (rmLogs > 0) {
		console.log(`ok 1 - Wrapper invoked for rm command (${rmLogs} logs found)`);
		process.exit(0);
	} else {
		console.log(`not ok 1 - Wrapper invoked for rm command`);
		console.log(`  # No wrapper logs found containing "rm -rf"`);
		process.exit(1);
	}
}

testWrapperInvokedForRmCommand().catch((error) => {
	console.log(`not ok 1 - Wrapper invoked for rm command`);
	console.log(`  # Error: ${error.message}`);
	process.exit(1);
});
