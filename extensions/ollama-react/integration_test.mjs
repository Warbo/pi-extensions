#!/usr/bin/env node
/**
 * Integration tests for ollama-react extension.
 *
 * Spins up pi in RPC mode with:
 *   - A fake OpenAI-compatible HTTP server returning canned ReAct text
 *   - The ollama-react extension to parse it
 *   - A dummy provider extension pointing at the fake server with api:"react"
 *
 * Verifies that parsed tool calls actually execute and produce real
 * filesystem side-effects.
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
	mkdirSync,
	writeFileSync,
	rmSync,
	existsSync,
	readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

let failures = 0;

function testPass(name) {
	console.log(`ok - ${name}`);
}

function testFail(name, reason) {
	failures++;
	console.log(`not ok - ${name}`);
	if (reason) console.log(`  # ${reason}`);
}

/**
 * Start a fake OpenAI-compatible server that returns canned ReAct text.
 *
 * `responses` is { keyword: "raw react text", ... }.
 * Key "default" is the fallback.
 *
 * If the last message is a tool result (user message starting with
 * "[Tool result"), returns plain text "Done." to stop the agent loop.
 */
function startFakeServer(responses, port) {
	const receivedRequests = [];
	const server = createServer((req, res) => {
		if (req.method === "POST" && req.url?.includes("/chat/completions")) {
			let body = "";
			req.on("data", (chunk) => (body += chunk));
			req.on("end", () => {
				try { receivedRequests.push(JSON.parse(body)); } catch {}
				let userText = "";
				let isToolResult = false;
				try {
					const parsed = JSON.parse(body);
					const messages = parsed.messages || [];
					// Find last user message for keyword matching
					for (let i = messages.length - 1; i >= 0; i--) {
						if (messages[i].role === "user") {
							userText = messages[i].content || "";
							break;
						}
					}
					// Check if the very last message is a tool result
					const last = messages[messages.length - 1];
					if (
						last?.role === "user" &&
						typeof last?.content === "string" &&
						last.content.startsWith("[Tool result")
					) {
						isToolResult = true;
					}
				} catch {}

				let reactText;
				if (isToolResult) {
					reactText = "Done.";
				} else {
					reactText = responses["default"] || "No response.";
					for (const [kw, text] of Object.entries(responses)) {
						if (
							kw !== "default" &&
							userText.toLowerCase().includes(kw.toLowerCase())
						) {
							reactText = text;
							break;
						}
					}
				}

				const responseBody = JSON.stringify({
					id: "dummy-1",
					object: "chat.completion",
					choices: [
						{
							index: 0,
							message: { role: "assistant", content: reactText },
							finish_reason: "stop",
						},
					],
					usage: {
						prompt_tokens: 100,
						completion_tokens: 50,
						total_tokens: 150,
					},
				});

				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(responseBody);
			});
		} else {
			res.writeHead(404);
			res.end("Not found");
		}
	});

	return new Promise((resolve) => {
		server.listen(port, () => resolve({ server, receivedRequests }));
	});
}

/**
 * Write a dummy LLM extension that registers a provider pointing at our
 * fake server with api:"react".
 */
function writeDummyLLMExtension(dir, port) {
	const path = join(dir, "dummy-llm.ts");
	writeFileSync(
		path,
		`
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerProvider("dummy", {
		baseUrl: "http://127.0.0.1:${port}/v1",
		apiKey: "dummy",
		api: "react" as any,
		models: [
			{
				id: "dummy-react",
				name: "Dummy ReAct Model",
				reasoning: false,
				input: ["text" as const],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 4096,
			},
		],
	});
}
`,
		"utf-8",
	);
	return path;
}

function startPi(extensions, cwd) {
	return spawn(
		"pi",
		[
			"--mode", "rpc",
			"--provider", "dummy",
			"--model", "dummy-react",
			...extensions.flatMap((ext) => ["-e", ext]),
		],
		{
			stdio: ["pipe", "pipe", "pipe"],
			cwd,
			env: { ...process.env, HOME: cwd },
		},
	);
}

function sendCommand(proc, cmd) {
	proc.stdin.write(JSON.stringify(cmd) + "\n");
}

/**
 * Wait for an event matching `predicate` to appear in the events array.
 * Starts searching from `startIndex` to avoid matching earlier events.
 */
function waitForEvent(events, predicate, { timeout = 20000, startIndex = 0 } = {}) {
	return new Promise((resolve, reject) => {
		const startTime = Date.now();
		const check = () => {
			for (let i = startIndex; i < events.length; i++) {
				if (predicate(events[i])) {
					resolve({ event: events[i], index: i });
					return;
				}
			}
			if (Date.now() - startTime > timeout) {
				const types = events.slice(startIndex).map((e) => e.type).join(", ");
				reject(new Error(`Timeout. Events from ${startIndex}: [${types}]`));
			} else {
				setTimeout(check, 50);
			}
		};
		check();
	});
}

/** Allocate a port that's unlikely to conflict across parallel tests. */
let nextPort = 19876;
function allocPort() {
	return nextPort++;
}

/**
 * Run a full scenario: fake server → pi → prompt → wait for agent_end.
 * Returns { events } for assertions. Cleans up automatically.
 */
async function runReActScenario(tempDir, reactExt, responses, prompt, setup) {
	const port = allocPort();
	const dummyLLMPath = writeDummyLLMExtension(tempDir, port);
	const { server, receivedRequests } = await startFakeServer(responses, port);

	if (setup) setup(tempDir);

	const pi = startPi([dummyLLMPath, reactExt], tempDir);
	const events = [];
	const rl = createInterface({ input: pi.stdout });
	rl.on("line", (line) => {
		try { events.push(JSON.parse(line)); } catch {}
	});

	let stderr = "";
	pi.stderr.on("data", (d) => (stderr += d.toString()));

	try {
		// Wait for pi to initialize
		await new Promise((resolve) => setTimeout(resolve, 1000));

		sendCommand(pi, { type: "prompt", message: prompt });

		// Wait for agent_end — this fires after ALL tools have completed
		// and the agent has finished its loop.
		await waitForEvent(events, (e) => e.type === "agent_end", { timeout: 20000 });

		// Small grace period for filesystem flush
		await new Promise((resolve) => setTimeout(resolve, 200));

		return { events, stderr, receivedRequests };
	} finally {
		pi.kill();
		await new Promise((resolve) => pi.on("close", resolve));
		server.close();
	}
}

async function runTest(name, testFn) {
	const tempDir = join(
		tmpdir(),
		`pi-react-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(tempDir, { recursive: true });

	try {
		const result = await Promise.race([
			testFn(tempDir, join(__dirname, "index.ts")),
			new Promise((_, reject) =>
				setTimeout(() => reject(new Error("Test timeout (45s)")), 45000),
			),
		]);

		if (result === true) {
			testPass(name);
		} else {
			testFail(name, result || "Test returned false");
		}
	} catch (error) {
		testFail(name, error.message);
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}

// -----------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------

(async function () {
	// ---- bash: touch creates a file ----
	await runTest(
		"bash tool: touch creates file",
		async (tempDir, reactExt) => {
			const target = join(tempDir, "created.txt");
			await runReActScenario(
				tempDir, reactExt,
				{ default: `THOUGHT: Creating the file.\n{"name": "bash", "arguments": {"command": "touch ${target}"}}` },
				"create file",
			);
			if (!existsSync(target)) return "File was not created";
			return true;
		},
	);

	// ---- bash: echo writes content ----
	await runTest(
		"bash tool: echo writes content to file",
		async (tempDir, reactExt) => {
			const target = join(tempDir, "echoed.txt");
			await runReActScenario(
				tempDir, reactExt,
				{ default: `THOUGHT: Writing content.\n{"name": "bash", "arguments": {"command": "echo hello-react > ${target}"}}` },
				"write content",
			);
			if (!existsSync(target)) return "File was not created";
			const content = readFileSync(target, "utf-8").trim();
			if (content !== "hello-react") return `Expected 'hello-react', got '${content}'`;
			return true;
		},
	);

	// ---- write tool: creates a new file ----
	await runTest(
		"write tool: creates a new file",
		async (tempDir, reactExt) => {
			const target = join(tempDir, "written.txt");
			const toolCall = JSON.stringify({
				name: "write",
				arguments: { path: target, content: "written by react" },
			});
			await runReActScenario(
				tempDir, reactExt,
				{ default: `THOUGHT: Writing file.\n${toolCall}` },
				"write the file",
			);
			if (!existsSync(target)) return "File not created";
			const content = readFileSync(target, "utf-8");
			if (content !== "written by react") return `Expected 'written by react', got '${content}'`;
			return true;
		},
	);

	// ---- write tool: creates parent directories ----
	await runTest(
		"write tool: creates parent directories",
		async (tempDir, reactExt) => {
			const target = join(tempDir, "sub", "dir", "deep.txt");
			const toolCall = JSON.stringify({
				name: "write",
				arguments: { path: target, content: "deep file" },
			});
			await runReActScenario(
				tempDir, reactExt,
				{ default: toolCall },
				"create deep file",
			);
			if (!existsSync(target)) return "Deep file not created";
			const content = readFileSync(target, "utf-8");
			if (content !== "deep file") return `Wrong content: '${content}'`;
			return true;
		},
	);

	// ---- read tool: content appears in tool result ----
	await runTest(
		"read tool: file content appears in tool_execution_end",
		async (tempDir, reactExt) => {
			const target = join(tempDir, "readable.txt");
			const toolCall = JSON.stringify({
				name: "read",
				arguments: { path: target },
			});
			const { events } = await runReActScenario(
				tempDir, reactExt,
				{ default: toolCall },
				"read the file",
				() => writeFileSync(target, "file content here", "utf-8"),
			);
			const toolEnd = events.find(
				(e) => e.type === "tool_execution_end" && e.toolName === "read",
			);
			if (!toolEnd) return `read tool_execution_end not found. Events: ${events.map((e) => e.type).join(", ")}`;
			const resultText = toolEnd.result?.content
				?.filter((c) => c.type === "text")
				.map((c) => c.text)
				.join("\n") ?? "";
			if (!resultText.includes("file content here")) {
				return `File content not in tool result. Got: '${resultText.slice(0, 200)}'`;
			}
			return true;
		},
	);

	// ---- read tool: content is passed back to the LLM ----
	await runTest(
		"read tool: file content is sent back to LLM in next request",
		async (tempDir, reactExt) => {
			const target = join(tempDir, "readable2.txt");
			const toolCall = JSON.stringify({
				name: "read",
				arguments: { path: target },
			});
			const { receivedRequests } = await runReActScenario(
				tempDir, reactExt,
				{ default: toolCall },
				"read the file",
				() => writeFileSync(target, "secret-content-12345", "utf-8"),
			);
			// The agent loop should make at least 2 requests:
			//   1. Initial prompt → returns read tool call
			//   2. Tool result fed back → returns "Done."
			if (receivedRequests.length < 2) {
				return `Expected >=2 LLM requests, got ${receivedRequests.length}`;
			}
			// The second request should contain the tool result with file content
			const secondReq = receivedRequests[1];
			const allContent = secondReq.messages
				.map((m) => m.content)
				.join("\n");
			if (!allContent.includes("secret-content-12345")) {
				return `File content not found in second LLM request. Messages:\n${JSON.stringify(secondReq.messages.map((m) => ({ role: m.role, content: m.content?.slice(0, 200) })), null, 2)}`;
			}
			return true;
		},
	);

	// ---- edit tool: modifies existing file ----
	await runTest(
		"edit tool: modifies existing file",
		async (tempDir, reactExt) => {
			const target = join(tempDir, "editable.txt");
			const toolCall = JSON.stringify({
				name: "edit",
				arguments: { path: target, oldText: "old content", newText: "new content" },
			});
			await runReActScenario(
				tempDir, reactExt,
				{ default: `THOUGHT: Editing.\n${toolCall}` },
				"edit the file",
				() => writeFileSync(target, "before\nold content\nafter", "utf-8"),
			);
			if (!existsSync(target)) return "File disappeared";
			const content = readFileSync(target, "utf-8");
			if (!content.includes("new content")) return `Edit not applied. Content: '${content}'`;
			if (content.includes("old content")) return `Old text still present. Content: '${content}'`;
			return true;
		},
	);

	// ---- THOUGHT blocks don't interfere with tool execution ----
	await runTest(
		"THOUGHT blocks don't prevent tool execution",
		async (tempDir, reactExt) => {
			const target = join(tempDir, "thought-test.txt");
			await runReActScenario(
				tempDir, reactExt,
				{
					default: [
						"THOUGHT: First I need to think carefully.",
						"There are several considerations.",
						"THOUGHT: Let me just create the file.",
						`{"name": "bash", "arguments": {"command": "echo thought-ok > ${target}"}}`,
					].join("\n"),
				},
				"do the thing",
			);
			if (!existsSync(target)) return "File not created despite THOUGHT blocks";
			const content = readFileSync(target, "utf-8").trim();
			if (content !== "thought-ok") return `Wrong content: '${content}'`;
			return true;
		},
	);

	// ---- Plain text response (no tool calls) doesn't crash ----
	await runTest(
		"plain text response completes normally",
		async (tempDir, reactExt) => {
			const { events } = await runReActScenario(
				tempDir, reactExt,
				{ default: "The answer is 42. No tools needed." },
				"what is the meaning of life",
			);
			const agentEnd = events.find((e) => e.type === "agent_end");
			if (!agentEnd) return "No agent_end event";
			return true;
		},
	);

	// ---- Multiple tool calls in one response ----
	await runTest(
		"multiple tool calls in one response",
		async (tempDir, reactExt) => {
			const file1 = join(tempDir, "multi1.txt");
			const file2 = join(tempDir, "multi2.txt");
			await runReActScenario(
				tempDir, reactExt,
				{
					default: [
						"THOUGHT: Creating two files.",
						`{"name": "bash", "arguments": {"command": "touch ${file1}"}}`,
						`{"name": "bash", "arguments": {"command": "touch ${file2}"}}`,
					].join("\n"),
				},
				"create two files",
			);
			if (!existsSync(file1)) return "First file not created";
			if (!existsSync(file2)) return "Second file not created";
			return true;
		},
	);

	if (failures > 0) {
		console.log(`\n${failures} integration test(s) failed`);
		process.exit(1);
	} else {
		console.log("\nAll integration tests passed");
	}
})();
