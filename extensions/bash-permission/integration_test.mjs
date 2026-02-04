#!/usr/bin/env node
/**
 * Integration tests for bash-permission extension
 * Tests extension with pi in RPC mode and actual command execution
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));

function testPass(name) {
	console.log(`ok - ${name}`);
}

function testFail(name, reason) {
	console.log(`not ok - ${name}`);
	if (reason) {
		console.log(`  # ${reason}`);
	}
}

function startPi(extensions, cwd) {
	const args = [
		"--mode", "rpc",
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

			// Check if the last message is a tool result with a blocked/error status
			const lastMessage = context.messages[context.messages.length - 1];
			
			// If the most recent message is a tool result indicating blocked/error, don't repeat the tool call
			if (lastMessage && (lastMessage.role === "tool" || lastMessage.role === "toolResult")) {
				const toolContent = typeof lastMessage.content === "string" 
					? lastMessage.content 
					: lastMessage.content?.find((c) => c.type === "text")?.text ?? "";
				
				// If the tool was blocked or errored, respond accordingly
				if (toolContent.toLowerCase().includes("blocked") || toolContent.toLowerCase().includes("error")) {
					stream.push({ type: "start", partial: output });
					const textContent = { type: "text" as const, text: "I understand the command was blocked." };
					output.content.push(textContent);
					stream.push({ type: "text_start", contentIndex: 0, partial: output });
					stream.push({ type: "text_delta", contentIndex: 0, delta: textContent.text, partial: output });
					stream.push({ type: "text_end", contentIndex: 0, content: textContent.text, partial: output });
					stream.push({ type: "done", reason: "stop", message: output });
					stream.end();
					return stream;
				}
			}

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



(async function() {
	await runTest("Permission dialog appears", async (pi, events, send) => {
		send(pi, { type: "prompt", message: "list files" });
		
		const uiRequest = await waitForEvent(events,
			e => e.type === "extension_ui_request" && e.method === "select"
		);
		
		if (!uiRequest.title || !uiRequest.title.includes("Bash Permission")) {
			return "UI request title doesn't include 'Bash Permission'";
		}
		
		if (!uiRequest.options || !uiRequest.options.includes("Allow once")) {
			return "UI request doesn't have expected options";
		}
		
		return true;
	});

	await runTest("Allow once permits command", async (pi, events, send) => {
		send(pi, { type: "prompt", message: "list files" });
		
		const uiRequest = await waitForEvent(events,
			e => e.type === "extension_ui_request" && e.method === "select"
		);
		
		send(pi, {
			type: "extension_ui_response",
			id: uiRequest.id,
			value: "Allow once"
		});
		
		const toolStart = await waitForEvent(events,
			e => e.type === "tool_execution_start" && e.toolName === "bash"
		);
		
		if (toolStart.args.command !== "ls -la") {
			return `Unexpected command: ${toolStart.args.command}`;
		}
		
		return true;
	});

	await runTest("Allow exact saves rule", async (pi, events, send, tempDir) => {
		send(pi, { type: "prompt", message: "check git status" });
		
		const uiRequest = await waitForEvent(events,
			e => e.type === "extension_ui_request" && e.method === "select"
		);
		
		send(pi, {
			type: "extension_ui_response",
			id: uiRequest.id,
			value: "Allow exact"
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

	await runTest("Multiple commands in same session", async (pi, events, send) => {
		send(pi, { type: "prompt", message: "list files" });
		
		let uiRequest = await waitForEvent(events,
			e => e.type === "extension_ui_request" && e.method === "select"
		);
		
		send(pi, {
			type: "extension_ui_response",
			id: uiRequest.id,
			value: "Allow once"
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
			value: "Deny once"
		});
		
		await new Promise(resolve => setTimeout(resolve, 500));
		
		return true;
	});

	await runTest("Extension preserves bash exit codes", async (pi, events, send, tempDir) => {
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

	// Blocked command does not execute
	{
		const tempDir = join(tmpdir(), `pi-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		
		const testFile = join(tempDir, "blocked-file.txt");
		const touchCommand = `touch ${testFile}`;

		const configPath = join(tempDir, ".config", "pi", "bash-permission.json");
		mkdirSync(join(tempDir, ".config", "pi"), { recursive: true });
		writeFileSync(configPath, JSON.stringify({
			deniedExact: [touchCommand],
			allowedExact: [],
			deniedPrefixes: [],
			allowedPrefixes: []
		}), "utf-8");

		const extension = join(__dirname, "index.ts");
		const dummyLLM = createCustomDummyLLM(tempDir, {
			"create file": { text: "Creating file", command: touchCommand }
		});

		const piArgs = [
			"--mode", "rpc",
			"--provider", "dummy",
			"--model", "dummy-model",
			"-e", dummyLLM,
			"-e", extension
		];
		
		const pi = spawn("pi", piArgs, {
			stdio: ["pipe", "pipe", "pipe"],
			cwd: tempDir,
			env: { ...process.env, HOME: tempDir }
		});
		
		const events = [];
		const readline = createInterface({ input: pi.stdout });
		readline.on("line", (line) => {
			try {
				events.push(JSON.parse(line));
			} catch (e) {}
		});

		try {
			await new Promise(resolve => setTimeout(resolve, 500));
			sendCommand(pi, { type: "prompt", message: "create file" });
			
			// Wait for response (should be quick now that LLM stops on blocked tools)
			await Promise.race([
				waitForEvent(events, e => e.type === "response"),
				new Promise(resolve => setTimeout(resolve, 5000))
			]);

			pi.kill();
			await new Promise((resolve) => pi.on("close", resolve));

			if (existsSync(testFile)) {
				testFail("Blocked command does not execute", `File was created despite blocking`);
			} else {
				testPass("Blocked command does not execute");
			}
		} catch (error) {
			pi.kill();
			await new Promise((resolve) => pi.on("close", resolve));
			testFail("Blocked command does not execute", error.message);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	}

	// Non-blocked command executes
	{
		const tempDir = join(tmpdir(), `pi-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		
		const testFile = join(tempDir, "allowed-file.txt");
		const touchCommand = `touch ${testFile}`;

		const configPath = join(tempDir, ".config", "pi", "bash-permission.json");
		mkdirSync(join(tempDir, ".config", "pi"), { recursive: true });
		writeFileSync(configPath, JSON.stringify({
			deniedExact: [],
			allowedExact: [touchCommand],
			deniedPrefixes: [],
			allowedPrefixes: []
		}), "utf-8");

		const extension = join(__dirname, "index.ts");
		const dummyLLM = createCustomDummyLLM(tempDir, {
			"create file": { text: "Creating file", command: touchCommand }
		});

		const pi = startPi([dummyLLM, extension], tempDir);
		const events = [];
		const readline = createInterface({ input: pi.stdout });
		readline.on("line", (line) => {
			try {
				events.push(JSON.parse(line));
			} catch (e) {}
		});

		try {
			await new Promise(resolve => setTimeout(resolve, 500));
			sendCommand(pi, { type: "prompt", message: "create file" });
			
			await Promise.race([
				waitForEvent(events, e => e.type === "response"),
				new Promise(resolve => setTimeout(resolve, 5000))
			]);

			pi.kill();
			await new Promise((resolve) => pi.on("close", resolve));

			if (!existsSync(testFile)) {
				testFail("Non-blocked command executes", `File was not created`);
			} else {
				testPass("Non-blocked command executes");
			}
		} catch (error) {
			pi.kill();
			await new Promise((resolve) => pi.on("close", resolve));
			testFail("Non-blocked command executes", error.message);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	}

	// User allow executes command
	{
		const tempDir = join(tmpdir(), `pi-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		
		const testFile = join(tempDir, "user-allowed-file.txt");
		const touchCommand = `touch ${testFile}`;

		const configPath = join(tempDir, ".config", "pi", "bash-permission.json");
		mkdirSync(join(tempDir, ".config", "pi"), { recursive: true });
		writeFileSync(configPath, JSON.stringify({
			deniedExact: [],
			allowedExact: [],
			deniedPrefixes: [],
			allowedPrefixes: []
		}), "utf-8");

		const extension = join(__dirname, "index.ts");
		const dummyLLM = createCustomDummyLLM(tempDir, {
			"create file": { text: "Creating file", command: touchCommand }
		});

		const pi = startPi([dummyLLM, extension], tempDir);
		const events = [];
		const readline = createInterface({ input: pi.stdout });
		readline.on("line", (line) => {
			try {
				events.push(JSON.parse(line));
			} catch (e) {}
		});

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
				value: "Allow once"
			});

			await Promise.race([
				waitForEvent(events, e => e.type === "response"),
				new Promise(resolve => setTimeout(resolve, 5000))
			]);

			pi.kill();
			await new Promise((resolve) => pi.on("close", resolve));

			if (!existsSync(testFile)) {
				testFail("User allow executes command", `File was not created after user allowed`);
			} else {
				testPass("User allow executes command");
			}
		} catch (error) {
			pi.kill();
			await new Promise((resolve) => pi.on("close", resolve));
			testFail("User allow executes command", error.message);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	}

	// User deny blocks command
	{
		const tempDir = join(tmpdir(), `pi-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		
		const testFile = join(tempDir, "user-denied-file.txt");
		const touchCommand = `touch ${testFile}`;

		const configPath = join(tempDir, ".config", "pi", "bash-permission.json");
		mkdirSync(join(tempDir, ".config", "pi"), { recursive: true });
		writeFileSync(configPath, JSON.stringify({
			deniedExact: [],
			allowedExact: [],
			deniedPrefixes: [],
			allowedPrefixes: []
		}), "utf-8");

		const extension = join(__dirname, "index.ts");
		const dummyLLM = createCustomDummyLLM(tempDir, {
			"create file": { text: "Creating file", command: touchCommand }
		});

		const pi = startPi([dummyLLM, extension], tempDir);
		const events = [];
		const readline = createInterface({ input: pi.stdout });
		readline.on("line", (line) => {
			try {
				events.push(JSON.parse(line));
			} catch (e) {}
		});

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
				value: "Deny once"
			});

			await Promise.race([
				waitForEvent(events, e => e.type === "response"),
				new Promise(resolve => setTimeout(resolve, 5000))
			]);

			pi.kill();
			await new Promise((resolve) => pi.on("close", resolve));

			if (existsSync(testFile)) {
				testFail("User deny blocks command", `File was created despite user denial`);
			} else {
				testPass("User deny blocks command");
			}
		} catch (error) {
			pi.kill();
			await new Promise((resolve) => pi.on("close", resolve));
			testFail("User deny blocks command", error.message);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	}

	// Blocked rm doesn't delete file
	{
		const tempDir = join(tmpdir(), `pi-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		
		const testFile = join(tempDir, "file-to-protect.txt");
		writeFileSync(testFile, "protected content", "utf-8");

		const rmCommand = `rm ${testFile}`;

		const configPath = join(tempDir, ".config", "pi", "bash-permission.json");
		mkdirSync(join(tempDir, ".config", "pi"), { recursive: true });
		writeFileSync(configPath, JSON.stringify({
			deniedExact: [rmCommand],
			allowedExact: [],
			deniedPrefixes: [],
			allowedPrefixes: []
		}), "utf-8");

		const extension = join(__dirname, "index.ts");
		const dummyLLM = createCustomDummyLLM(tempDir, {
			"delete file": { text: "Deleting file", command: rmCommand }
		});

		const pi = startPi([dummyLLM, extension], tempDir);
		const events = [];
		const readline = createInterface({ input: pi.stdout });
		readline.on("line", (line) => {
			try {
				events.push(JSON.parse(line));
			} catch (e) {}
		});

		try {
			await new Promise(resolve => setTimeout(resolve, 500));
			sendCommand(pi, { type: "prompt", message: "delete file" });
			
			await Promise.race([
				waitForEvent(events, e => e.type === "response"),
				new Promise(resolve => setTimeout(resolve, 5000))
			]);

			pi.kill();
			await new Promise((resolve) => pi.on("close", resolve));

			if (!existsSync(testFile)) {
				testFail("Blocked rm doesn't delete file", `File was deleted despite blocking`);
			} else {
				testPass("Blocked rm doesn't delete file");
			}
		} catch (error) {
			pi.kill();
			await new Promise((resolve) => pi.on("close", resolve));
			testFail("Blocked rm doesn't delete file", error.message);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	}

	process.exit(0);
})();
