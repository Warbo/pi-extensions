#!/usr/bin/env node
/**
 * Tests for bash-permission extension
 * - Unit tests: config and command matching logic
 * - Integration tests: extension with pi in RPC mode
 * - Blocking tests: verify actual command effects
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
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

// ============================================================================
// UNIT TESTS - Config and command matching logic
// ============================================================================

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

function runUnitTest(name, testFn) {
	try {
		testFn();
		testPass(name);
	} catch (error) {
		testFail(name, error.message);
	}
}

function unitTests() {
	console.log("# Unit tests - config and matching logic");

	runUnitTest("Config loading - empty config", () => {
		const config = new TestConfig();
		if (config.config.allowedExact.length !== 0) {
			throw new Error("Expected empty allowedExact");
		}
		if (config.config.confirmTimeout !== 30000) {
			throw new Error("Expected default timeout 30000");
		}
	});

	runUnitTest("Config loading - populated config", () => {
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

	runUnitTest("Config saving - write and read back", () => {
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

	runUnitTest("Command matching - exact allow", () => {
		const config = new TestConfig();
		config.loadFrom({ allowedExact: ["ls -la", "pwd"] });
		
		const result = config.checkCommand("ls -la");
		if (result !== "allowed") {
			throw new Error(`Expected 'allowed', got '${result}'`);
		}
	});

	runUnitTest("Command matching - exact deny", () => {
		const config = new TestConfig();
		config.loadFrom({ deniedExact: ["rm -rf /"] });
		
		const result = config.checkCommand("rm -rf /");
		if (result !== "denied") {
			throw new Error(`Expected 'denied', got '${result}'`);
		}
	});

	runUnitTest("Command matching - prefix allow", () => {
		const config = new TestConfig();
		config.loadFrom({ allowedPrefixes: ["git "] });
		
		const result1 = config.checkCommand("git status");
		const result2 = config.checkCommand("git log --oneline");
		
		if (result1 !== "allowed" || result2 !== "allowed") {
			throw new Error("Prefix allow didn't match");
		}
	});

	runUnitTest("Command matching - prefix deny", () => {
		const config = new TestConfig();
		config.loadFrom({ deniedPrefixes: ["sudo rm"] });
		
		const result = config.checkCommand("sudo rm -rf /home");
		if (result !== "denied") {
			throw new Error(`Expected 'denied', got '${result}'`);
		}
	});

	runUnitTest("Command matching - unknown command", () => {
		const config = new TestConfig();
		config.loadFrom({ allowedExact: ["ls"] });
		
		const result = config.checkCommand("echo hello");
		if (result !== "unknown") {
			throw new Error(`Expected 'unknown', got '${result}'`);
		}
	});

	runUnitTest("Priority order - exact deny over exact allow", () => {
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

	runUnitTest("Priority order - exact allow over prefix deny", () => {
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

	runUnitTest("Edge case - multi-line command matching", () => {
		const config = new TestConfig();
		config.loadFrom({ allowedPrefixes: ["echo "] });
		
		const multilineCmd = "echo 'line1\nline2\nline3'";
		const result = config.checkCommand(multilineCmd);
		
		if (result !== "allowed") {
			throw new Error(`Expected 'allowed' for multiline, got '${result}'`);
		}
	});

	runUnitTest("Edge case - piped command matching", () => {
		const config = new TestConfig();
		config.loadFrom({ allowedPrefixes: ["ls "] });
		
		const pipedCmd = "ls -la | grep test";
		const result = config.checkCommand(pipedCmd);
		
		if (result !== "allowed") {
			throw new Error(`Expected 'allowed' for piped command, got '${result}'`);
		}
	});

	runUnitTest("Edge case - escaped characters in command", () => {
		const config = new TestConfig();
		config.loadFrom({ allowedExact: ["echo \"hello world\""] });
		
		const result = config.checkCommand("echo \"hello world\"");
		if (result !== "allowed") {
			throw new Error(`Expected 'allowed' for escaped chars, got '${result}'`);
		}
	});

	runUnitTest("Edge case - empty prefix handling", () => {
		const config = new TestConfig();
		config.loadFrom({ allowedPrefixes: [""] });
		
		const result = config.checkCommand("any command");
		if (result !== "allowed") {
			throw new Error(`Expected 'allowed' with empty prefix, got '${result}'`);
		}
	});
}

// ============================================================================
// INTEGRATION TESTS - Extension with pi in RPC mode
// ============================================================================

function startPi(extensions, cwd) {
	const args = [
		"--mode", "rpc",
		"--no-session",
		"--provider", "dummy",
		"--model", "dummy-model",
		...extensions.flatMap(ext => ["-e", ext])
	];
	
	return spawn("pi", args, {
		stdio: ["pipe", "pipe", "pipe"],
		cwd,
		env: { ...process.env, HOME: cwd }
	});
}

function sendCommand(proc, cmd) {
	proc.stdin.write(JSON.stringify(cmd) + "\n");
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

async function runIntegrationTest(name, testFn) {
	const tempDir = join(tmpdir(), `pi-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });
	
	const dummyLLM = join(__dirname, "test-dummy-llm.ts");
	const bashPermission = join(__dirname, "index.ts");
	
	const pi = startPi([dummyLLM, bashPermission], tempDir);
	
	const events = [];
	const readline = createInterface({ input: pi.stdout });
	
	readline.on("line", (line) => {
		try {
			events.push(JSON.parse(line));
		} catch (e) {}
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

async function integrationTests() {
	console.log("# Integration tests - extension with pi");

	await runIntegrationTest("Permission dialog appears", async (pi, events, send) => {
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

	await runIntegrationTest("Allow once permits command", async (pi, events, send) => {
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

	await runIntegrationTest("Allow exact saves rule", async (pi, events, send, tempDir) => {
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
		
		await new Promise(resolve => setTimeout(resolve, 500));
		
		const configPath = join(tempDir, ".config", "pi", "bash-permission.json");
		try {
			const configData = JSON.parse(readFileSync(configPath, "utf-8"));
			if (!configData.allowedExact || !configData.allowedExact.includes("git status")) {
				return "Config not saved correctly";
			}
		} catch (e) {
			return `Config file error: ${e.message}`;
		}
		
		return true;
	});

	await runIntegrationTest("Multiple commands in same session", async (pi, events, send) => {
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
		
		send(pi, { type: "prompt", message: "check git status" });
		
		uiRequest = await waitForEvent(events,
			e => e.type === "extension_ui_request" && e.method === "select" && e.id !== uiRequest.id
		);
		
		send(pi, {
			type: "extension_ui_response",
			id: uiRequest.id,
			value: "❌ Deny once"
		});
		
		await new Promise(resolve => setTimeout(resolve, 500));
		
		return true;
	});

	await runIntegrationTest("Extension preserves bash exit codes", async (pi, events, send, tempDir) => {
		const configPath = join(tempDir, ".config", "pi", "bash-permission.json");
		mkdirSync(join(tempDir, ".config", "pi"), { recursive: true });
		writeFileSync(configPath, JSON.stringify({
			allowedPrefixes: [""],
			allowedExact: [],
			deniedPrefixes: [],
			deniedExact: []
		}), "utf-8");
		
		send(pi, { type: "prompt", message: "check git status" });
		
		const successResult = await waitForEvent(events,
			e => e.type === "tool_execution_end" && e.toolName === "bash"
		);
		
		if (!successResult.result) {
			return "No result from bash tool";
		}
		
		return true;
	});
}

// ============================================================================
// BLOCKING TESTS - Verify actual command effects
// ============================================================================

function getExtension() {
	return join(__dirname, "index.ts");
}

function getDummyLLM() {
	return join(__dirname, "test-dummy-llm.ts");
}

function setupConfig(tempDir, config) {
	const configDir = join(tempDir, ".config", "pi");
	mkdirSync(configDir, { recursive: true });
	const configPath = join(configDir, "bash-permission.json");
	writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
}

function createCustomDummyLLM(tempDir, responses) {
	const llmPath = join(tempDir, "custom-llm.ts");
	const responsesJson = JSON.stringify(responses);
	const llmCode = `
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
	createAssistantMessageEventStream,
} from "@mariozechner/pi-ai";

const responses = ${responsesJson};

function streamDummyLLM(
	model: Model<any>,
	context: Context,
	options?: SimpleStreamOptions
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 100,
				output: 50,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 150,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		try {
			if (options?.signal?.aborted) throw new Error("Aborted");

			const lastUserMsg = context.messages.findLast((m) => m.role === "user");
			const userText =
				typeof lastUserMsg?.content === "string"
					? lastUserMsg.content
					: lastUserMsg?.content?.find((c) => c.type === "text")?.text ?? "";

			let response = responses.default || { text: "OK", command: null };
			for (const [key, value] of Object.entries(responses)) {
				if (userText.toLowerCase().includes(key.toLowerCase())) {
					response = value;
					break;
				}
			}

			stream.push({ type: "start", partial: output });

			const textContent = { type: "text" as const, text: response.text };
			output.content.push(textContent);
			stream.push({ type: "text_start", contentIndex: 0, partial: output });
			stream.push({ type: "text_delta", contentIndex: 0, delta: response.text, partial: output });
			stream.push({ type: "text_end", contentIndex: 0, content: response.text, partial: output });

			if (response.command) {
				output.stopReason = "toolUse";
				const toolCall = {
					type: "toolCall" as const,
					id: \`call_\${Date.now()}\`,
					name: "bash",
					arguments: { command: response.command },
				};
				output.content.push(toolCall);
				stream.push({ type: "toolcall_start", contentIndex: 1, partial: output });
				stream.push({ type: "toolcall_end", contentIndex: 1, toolCall, partial: output });
			}

			stream.push({ type: "done", reason: output.stopReason as any, message: output });
			stream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
}

export default function (pi: ExtensionAPI) {
	pi.registerProvider("dummy", {
		baseUrl: "http://localhost:1234",
		apiKey: "dummy-key",
		api: "openai-completions",
		models: [
			{
				id: "dummy-model",
				name: "Dummy Test Model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 4096,
			},
		],
		streamSimple: streamDummyLLM,
	});
}
`;
	writeFileSync(llmPath, llmCode, "utf-8");
	return llmPath;
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

async function runBlockingTest(name, testFn) {
	try {
		await testFn();
		testPass(name);
	} catch (error) {
		testFail(name, error.message);
	}
}

async function blockingTests() {
	console.log("# Blocking tests - actual command effects");

	await runBlockingTest("Blocked command does not execute", async () => {
		const tempCwd = join(tmpdir(), `pi-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempCwd, { recursive: true });

		const testFile = join(tempCwd, "blocked-file.txt");
		const touchCommand = `touch ${testFile}`;

		setupConfig(tempCwd, {
			deniedExact: [touchCommand],
			allowedExact: [],
			deniedPrefixes: [],
			allowedPrefixes: []
		});

		const extension = getExtension();
		const dummyLLM = createCustomDummyLLM(tempCwd, {
			"create file": { text: "Creating file", command: touchCommand }
		});

		const pi = startPi([dummyLLM, extension], tempCwd);
		setupEventLogging(pi);

		try {
			await new Promise(resolve => setTimeout(resolve, 500));
			sendCommand(pi, { type: "prompt", message: "create file" });
			await new Promise(resolve => setTimeout(resolve, 2000));
			pi.kill();
			await new Promise((resolve) => pi.on("close", resolve));

			if (existsSync(testFile)) {
				throw new Error(`File ${testFile} was created despite blocking`);
			}
		} finally {
			rmSync(tempCwd, { recursive: true, force: true });
		}
	});

	await runBlockingTest("Non-blocked command executes", async () => {
		const tempCwd = join(tmpdir(), `pi-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempCwd, { recursive: true });

		const testFile = join(tempCwd, "allowed-file.txt");
		const touchCommand = `touch ${testFile}`;

		setupConfig(tempCwd, {
			deniedExact: [],
			allowedExact: [touchCommand],
			deniedPrefixes: [],
			allowedPrefixes: []
		});

		const extension = getExtension();
		const dummyLLM = createCustomDummyLLM(tempCwd, {
			"create file": { text: "Creating file", command: touchCommand }
		});

		const pi = startPi([dummyLLM, extension], tempCwd);
		setupEventLogging(pi);

		try {
			await new Promise(resolve => setTimeout(resolve, 500));
			sendCommand(pi, { type: "prompt", message: "create file" });
			await new Promise(resolve => setTimeout(resolve, 2000));
			pi.kill();
			await new Promise((resolve) => pi.on("close", resolve));

			if (!existsSync(testFile)) {
				throw new Error(`File ${testFile} was not created`);
			}
		} finally {
			rmSync(tempCwd, { recursive: true, force: true });
		}
	});

	await runBlockingTest("User allow executes command", async () => {
		const tempCwd = join(tmpdir(), `pi-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempCwd, { recursive: true });

		const testFile = join(tempCwd, "user-allowed-file.txt");
		const touchCommand = `touch ${testFile}`;

		setupConfig(tempCwd, {
			deniedExact: [],
			allowedExact: [],
			deniedPrefixes: [],
			allowedPrefixes: []
		});

		const extension = getExtension();
		const dummyLLM = createCustomDummyLLM(tempCwd, {
			"create file": { text: "Creating file", command: touchCommand }
		});

		const pi = startPi([dummyLLM, extension], tempCwd);
		const events = setupEventLogging(pi);

		try {
			await new Promise(resolve => setTimeout(resolve, 500));
			sendCommand(pi, { type: "prompt", message: "create file" });

			const uiRequest = await waitForEvent(events,
				e => e.type === "extension_ui_request" && e.method === "select",
				5000
			);

			sendCommand(pi, {
				type: "extension_ui_response",
				id: uiRequest.id,
				value: "✅ Allow once"
			});

			await new Promise(resolve => setTimeout(resolve, 1000));
			pi.kill();
			await new Promise((resolve) => pi.on("close", resolve));

			if (!existsSync(testFile)) {
				throw new Error(`File ${testFile} was not created after user allowed`);
			}
		} finally {
			rmSync(tempCwd, { recursive: true, force: true });
		}
	});

	await runBlockingTest("User deny blocks command", async () => {
		const tempCwd = join(tmpdir(), `pi-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempCwd, { recursive: true });

		const testFile = join(tempCwd, "user-denied-file.txt");
		const touchCommand = `touch ${testFile}`;

		setupConfig(tempCwd, {
			deniedExact: [],
			allowedExact: [],
			deniedPrefixes: [],
			allowedPrefixes: []
		});

		const extension = getExtension();
		const dummyLLM = createCustomDummyLLM(tempCwd, {
			"create file": { text: "Creating file", command: touchCommand }
		});

		const pi = startPi([dummyLLM, extension], tempCwd);
		const events = setupEventLogging(pi);

		try {
			await new Promise(resolve => setTimeout(resolve, 500));
			sendCommand(pi, { type: "prompt", message: "create file" });

			const uiRequest = await waitForEvent(events,
				e => e.type === "extension_ui_request" && e.method === "select",
				5000
			);

			sendCommand(pi, {
				type: "extension_ui_response",
				id: uiRequest.id,
				value: "❌ Deny once"
			});

			await new Promise(resolve => setTimeout(resolve, 1000));
			pi.kill();
			await new Promise((resolve) => pi.on("close", resolve));

			if (existsSync(testFile)) {
				throw new Error(`File ${testFile} was created despite user denial`);
			}
		} finally {
			rmSync(tempCwd, { recursive: true, force: true });
		}
	});

	await runBlockingTest("Blocked rm doesn't delete file", async () => {
		const tempCwd = join(tmpdir(), `pi-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempCwd, { recursive: true });

		const testFile = join(tempCwd, "file-to-protect.txt");
		writeFileSync(testFile, "protected content", "utf-8");

		const rmCommand = `rm ${testFile}`;

		setupConfig(tempCwd, {
			deniedExact: [rmCommand],
			allowedExact: [],
			deniedPrefixes: [],
			allowedPrefixes: []
		});

		const extension = getExtension();
		const dummyLLM = createCustomDummyLLM(tempCwd, {
			"delete file": { text: "Deleting file", command: rmCommand }
		});

		const pi = startPi([dummyLLM, extension], tempCwd);
		setupEventLogging(pi);

		try {
			await new Promise(resolve => setTimeout(resolve, 500));
			sendCommand(pi, { type: "prompt", message: "delete file" });
			await new Promise(resolve => setTimeout(resolve, 2000));
			pi.kill();
			await new Promise((resolve) => pi.on("close", resolve));

			if (!existsSync(testFile)) {
				throw new Error(`File ${testFile} was deleted despite blocking`);
			}
		} finally {
			rmSync(tempCwd, { recursive: true, force: true });
		}
	});
}

// ============================================================================
// RUN ALL TESTS
// ============================================================================

(async function() {
	console.log("TAP version 13");
	console.log("1..24");

	unitTests();
	await integrationTests();
	await blockingTests();

	process.exit(testsFailed === 0 ? 0 : 1);
})();
