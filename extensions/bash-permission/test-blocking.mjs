#!/usr/bin/env node
/**
 * Integration tests for bash-permission extension
 * 
 * Verifies that the extension actually blocks bash commands using pi's
 * official { block: true } mechanism from tool_call event handlers.
 * 
 * Tests check actual command effects (file creation/deletion) not just events.
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));

let testsFailed = 0;

function testPass(name) {
	console.log(`ok - ${name}`);
}

function testFail(name, reason) {
	testsFailed++;
	console.log(`not ok - ${name}`);
	if (reason) {
		console.log(`  # ${reason}`);
	}
}

// Get the actual extension and dummy LLM from this directory
function getExtension() {
	return join(__dirname, "index.ts");
}

function getDummyLLM() {
	return join(__dirname, "test-dummy-llm.ts");
}

// Create config file to pre-configure blocked commands
function setupConfig(tempDir, config) {
	const configDir = join(tempDir, ".config", "pi");
	mkdirSync(configDir, { recursive: true });
	const configPath = join(configDir, "bash-permission.json");
	writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
}

// Create a custom dummy LLM that responds with specific commands
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

// Start pi in RPC mode with extensions
function startPi(extensions, cwd, env = {}) {
	const pi = spawn("pi", [
		"--mode", "rpc",
		"--no-session",
		"--provider", "dummy",
		"--model", "dummy-model",
		...extensions.flatMap(ext => ["--extension", ext])
	], {
		stdio: ["pipe", "pipe", "pipe"],
		cwd,
		env: { ...process.env, HOME: cwd, ...env }
	});

	return pi;
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

function setupEventLogging(pi) {
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
	return events;
}

// Test 1: Blocked command should not execute (file should not be created)
async function testBlockedCommandDoesNotExecute() {
	const tempCwd = join(tmpdir(), `pi-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempCwd, { recursive: true });

	const testFile = join(tempCwd, "blocked-file.txt");
	const touchCommand = `touch ${testFile}`;

	// Pre-configure extension to deny this command
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
	const events = setupEventLogging(pi);

	try {
		await new Promise(resolve => setTimeout(resolve, 500));

		sendCommand(pi, { type: "prompt", message: "create file" });

		// Wait for agent to finish
		await new Promise(resolve => setTimeout(resolve, 2000));

		pi.kill();
		await new Promise(resolve => pi.on("close", resolve));

		// Check if file was created
		if (!existsSync(testFile)) {
			testPass("Blocked command does not execute (file not created)");
		} else {
			testFail("Blocked command does not execute (file not created)",
				`File ${testFile} was created despite blocking`);
		}
	} catch (error) {
		pi.kill();
		await new Promise(resolve => setTimeout(resolve, 100));
		testFail("Blocked command does not execute (file not created)", error.message);
	} finally {
		rmSync(tempCwd, { recursive: true, force: true });
	}
}

// Test 2: Non-blocked command should execute (file should be created)
async function testNonBlockedCommandExecutes() {
	const tempCwd = join(tmpdir(), `pi-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempCwd, { recursive: true });

	const testFile = join(tempCwd, "allowed-file.txt");
	const touchCommand = `touch ${testFile}`;

	// Pre-configure extension to allow this command
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
	const events = setupEventLogging(pi);

	try {
		await new Promise(resolve => setTimeout(resolve, 500));

		sendCommand(pi, { type: "prompt", message: "create file" });

		// Wait for command to execute
		await new Promise(resolve => setTimeout(resolve, 2000));

		pi.kill();
		await new Promise(resolve => pi.on("close", resolve));

		// Check if file was created
		if (existsSync(testFile)) {
			testPass("Non-blocked command executes (file created)");
		} else {
			testFail("Non-blocked command executes (file created)",
				`File ${testFile} was not created`);
		}
	} catch (error) {
		pi.kill();
		await new Promise(resolve => setTimeout(resolve, 100));
		testFail("Non-blocked command executes (file created)", error.message);
	} finally {
		rmSync(tempCwd, { recursive: true, force: true });
	}
}

// Test 3: User allowing command should execute it (file should be created)
async function testUserAllowExecutesCommand() {
	const tempCwd = join(tmpdir(), `pi-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempCwd, { recursive: true });

	const testFile = join(tempCwd, "user-allowed-file.txt");
	const touchCommand = `touch ${testFile}`;

	// Don't pre-configure - let user be prompted
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

		// Wait for permission dialog
		const uiRequest = await waitForEvent(events,
			e => e.type === "extension_ui_request" && e.method === "select",
			5000
		);

		// User allows (choose "Allow once")
		sendCommand(pi, {
			type: "extension_ui_response",
			id: uiRequest.id,
			value: "✅ Allow once"
		});

		// Wait for command to execute
		await new Promise(resolve => setTimeout(resolve, 1000));

		pi.kill();
		await new Promise(resolve => pi.on("close", resolve));

		// Check if file was created
		if (existsSync(testFile)) {
			testPass("User allowing command executes it (file created)");
		} else {
			testFail("User allowing command executes it (file created)",
				`File ${testFile} was not created after user allowed`);
		}
	} catch (error) {
		pi.kill();
		await new Promise(resolve => setTimeout(resolve, 100));
		testFail("User allowing command executes it (file created)", error.message);
	} finally {
		rmSync(tempCwd, { recursive: true, force: true });
	}
}

// Test 4: User denying command should not execute it (file should not be created)
async function testUserDenyBlocksCommand() {
	const tempCwd = join(tmpdir(), `pi-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempCwd, { recursive: true });

	const testFile = join(tempCwd, "user-denied-file.txt");
	const touchCommand = `touch ${testFile}`;

	// Don't pre-configure - let user be prompted
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

		// Wait for permission dialog
		const uiRequest = await waitForEvent(events,
			e => e.type === "extension_ui_request" && e.method === "select",
			5000
		);

		// User denies (choose "Deny once")
		sendCommand(pi, {
			type: "extension_ui_response",
			id: uiRequest.id,
			value: "❌ Deny once"
		});

		// Wait a bit
		await new Promise(resolve => setTimeout(resolve, 1000));

		pi.kill();
		await new Promise(resolve => pi.on("close", resolve));

		// Check if file was NOT created
		if (!existsSync(testFile)) {
			testPass("User denying command blocks it (file not created)");
		} else {
			testFail("User denying command blocks it (file not created)",
				`File ${testFile} was created despite user denial`);
		}
	} catch (error) {
		pi.kill();
		await new Promise(resolve => setTimeout(resolve, 100));
		testFail("User denying command blocks it (file not created)", error.message);
	} finally {
		rmSync(tempCwd, { recursive: true, force: true });
	}
}

// Test 5: Blocked rm command should not delete file
async function testBlockedRmDoesNotDeleteFile() {
	const tempCwd = join(tmpdir(), `pi-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempCwd, { recursive: true });

	const testFile = join(tempCwd, "file-to-protect.txt");
	writeFileSync(testFile, "protected content", "utf-8");

	const rmCommand = `rm ${testFile}`;

	// Pre-configure extension to deny rm commands
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
	const events = setupEventLogging(pi);

	try {
		await new Promise(resolve => setTimeout(resolve, 500));

		sendCommand(pi, { type: "prompt", message: "delete file" });

		// Wait for agent to finish
		await new Promise(resolve => setTimeout(resolve, 2000));

		pi.kill();
		await new Promise(resolve => pi.on("close", resolve));

		// Check if file still exists
		if (existsSync(testFile)) {
			testPass("Blocked rm command does not delete file");
		} else {
			testFail("Blocked rm command does not delete file",
				`File ${testFile} was deleted despite blocking`);
		}
	} catch (error) {
		pi.kill();
		await new Promise(resolve => setTimeout(resolve, 100));
		testFail("Blocked rm command does not delete file", error.message);
	} finally {
		rmSync(tempCwd, { recursive: true, force: true });
	}
}

// Run all tests
(async function() {
	console.log("TAP version 13");
	console.log("1..5");
	console.log("# Testing bash-permission extension");
	console.log("# Tests verify actual command effects (file creation/deletion)");

	try {
		await testBlockedCommandDoesNotExecute();
		await testNonBlockedCommandExecutes();
		await testUserAllowExecutesCommand();
		await testUserDenyBlocksCommand();
		await testBlockedRmDoesNotDeleteFile();
	} catch (error) {
		console.log(`# FATAL ERROR: ${error.message}`);
		console.log(`# Stack: ${error.stack}`);
		process.exit(1);
	}

	process.exit(testsFailed === 0 ? 0 : 1);
})();
