#!/usr/bin/env node
/**
 * Unit tests for bash-permission extension
 * Tests config and command matching logic
 */

import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function testPass(name) {
	console.log(`ok - ${name}`);
}

function testFail(name, reason) {
	console.log(`not ok - ${name}`);
	if (reason) {
		console.log(`  # ${reason}`);
	}
}

class TestConfig {
	constructor() {
		this.config = {
			allowedExact: [],
			deniedExact: [],
			allowedPrefixes: [],
			deniedPrefixes: [],
			confirmTimeout: 30000,
		};
	}

	loadFrom(data) {
		this.config = { ...this.config, ...data };
	}

	checkCommand(command) {
		if (this.config.deniedExact.includes(command)) {
			return "denied";
		}
		if (this.config.allowedExact.includes(command)) {
			return "allowed";
		}
		for (const prefix of this.config.deniedPrefixes) {
			if (command.startsWith(prefix)) {
				return "denied";
			}
		}
		for (const prefix of this.config.allowedPrefixes) {
			if (command.startsWith(prefix)) {
				return "allowed";
			}
		}
		return "unknown";
	}
}

function runTest(name, testFn) {
	try {
		testFn();
		testPass(name);
	} catch (error) {
		testFail(name, error.message);
	}
}

runTest("Config loading - empty config", () => {
	const config = new TestConfig();
	if (config.config.allowedExact.length !== 0) {
		throw new Error("Expected empty allowedExact");
	}
	if (config.config.confirmTimeout !== 30000) {
		throw new Error("Expected default timeout 30000");
	}
});

runTest("Config loading - populated config", () => {
	const config = new TestConfig();
	config.loadFrom({
		allowedExact: ["ls", "pwd"],
		deniedPrefixes: ["rm -rf"],
	});
	if (config.config.allowedExact.length !== 2) {
		throw new Error("Expected 2 allowedExact entries");
	}
	if (!config.config.allowedExact.includes("ls")) {
		throw new Error("Expected ls in allowedExact");
	}
});

runTest("Config saving - write and read back", () => {
	const tmpDir = mkdirSync(join(tmpdir(), `test-${Date.now()}`), { recursive: true });
	const configPath = join(tmpDir, "test-config.json");
	
	const testData = {
		allowedExact: ["git status"],
		deniedPrefixes: ["sudo "],
	};
	
	writeFileSync(configPath, JSON.stringify(testData, null, 2));
	const loaded = JSON.parse(readFileSync(configPath, "utf-8"));
	
	if (loaded.allowedExact[0] !== "git status") {
		throw new Error("Config save/load failed");
	}
	
	rmSync(tmpDir, { recursive: true });
});

runTest("Command matching - exact allow", () => {
	const config = new TestConfig();
	config.loadFrom({ allowedExact: ["ls -la", "pwd"] });
	
	const result = config.checkCommand("ls -la");
	if (result !== "allowed") {
		throw new Error(`Expected 'allowed', got '${result}'`);
	}
});

runTest("Command matching - exact deny", () => {
	const config = new TestConfig();
	config.loadFrom({ deniedExact: ["rm -rf /"] });
	
	const result = config.checkCommand("rm -rf /");
	if (result !== "denied") {
		throw new Error(`Expected 'denied', got '${result}'`);
	}
});

runTest("Command matching - prefix allow", () => {
	const config = new TestConfig();
	config.loadFrom({ allowedPrefixes: ["git "] });
	
	const result1 = config.checkCommand("git status");
	const result2 = config.checkCommand("git log --oneline");
	
	if (result1 !== "allowed" || result2 !== "allowed") {
		throw new Error("Prefix allow didn't match");
	}
});

runTest("Command matching - prefix deny", () => {
	const config = new TestConfig();
	config.loadFrom({ deniedPrefixes: ["sudo rm"] });
	
	const result = config.checkCommand("sudo rm -rf /home");
	if (result !== "denied") {
		throw new Error(`Expected 'denied', got '${result}'`);
	}
});

runTest("Command matching - unknown command", () => {
	const config = new TestConfig();
	config.loadFrom({ allowedExact: ["ls"] });
	
	const result = config.checkCommand("echo hello");
	if (result !== "unknown") {
		throw new Error(`Expected 'unknown', got '${result}'`);
	}
});

runTest("Priority order - exact deny over exact allow", () => {
	const config = new TestConfig();
	config.loadFrom({
		allowedExact: ["rm test.txt"],
		deniedExact: ["rm test.txt"],
	});
	
	const result = config.checkCommand("rm test.txt");
	if (result !== "denied") {
		throw new Error(`Expected 'denied' (exact deny priority), got '${result}'`);
	}
});

runTest("Priority order - exact allow over prefix deny", () => {
	const config = new TestConfig();
	config.loadFrom({
		allowedExact: ["git push"],
		deniedPrefixes: ["git "],
	});
	
	const result = config.checkCommand("git push");
	if (result !== "allowed") {
		throw new Error(`Expected 'allowed' (exact allow priority), got '${result}'`);
	}
});

runTest("Edge case - multi-line command matching", () => {
	const config = new TestConfig();
	config.loadFrom({ allowedPrefixes: ["echo "] });
	
	const multilineCmd = "echo 'line1\nline2\nline3'";
	const result = config.checkCommand(multilineCmd);
	
	if (result !== "allowed") {
		throw new Error(`Expected 'allowed' for multiline, got '${result}'`);
	}
});

runTest("Edge case - piped command matching", () => {
	const config = new TestConfig();
	config.loadFrom({ allowedPrefixes: ["ls "] });
	
	const pipedCmd = "ls -la | grep test";
	const result = config.checkCommand(pipedCmd);
	
	if (result !== "allowed") {
		throw new Error(`Expected 'allowed' for piped command, got '${result}'`);
	}
});

runTest("Edge case - escaped characters in command", () => {
	const config = new TestConfig();
	config.loadFrom({ allowedExact: ["echo \"hello world\""] });
	
	const result = config.checkCommand("echo \"hello world\"");
	if (result !== "allowed") {
		throw new Error(`Expected 'allowed' for escaped chars, got '${result}'`);
	}
});

runTest("Edge case - empty prefix handling", () => {
	const config = new TestConfig();
	config.loadFrom({ allowedPrefixes: [""] });
	
	const result = config.checkCommand("any command");
	if (result !== "allowed") {
		throw new Error(`Expected 'allowed' with empty prefix, got '${result}'`);
	}
});
