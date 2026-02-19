#!/usr/bin/env node
/**
 * Integration tests for artemis extension
 * Tests extension with pi in RPC mode and actual git artemis execution
 */

import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
let failCount = 0;
const trackedProcesses = [];

function testPass(name) {
	console.log(`ok - ${name}`);
}

function testFail(name, reason) {
	console.log(`not ok - ${name}`);
	if (reason) {
		console.log(`  # ${reason}`);
	}
	failCount++;
}

function startPi(extensions, cwd) {
	const args = [
		"--mode", "rpc",
		"--provider", "dummy",
		"--model", "dummy-model",
		...extensions.flatMap(ext => ["-e", ext])
	];
	
	const proc = spawn("pi", args, {
		stdio: ["pipe", "pipe", "pipe"],
		cwd,
		env: { ...process.env, HOME: cwd }
	});
	trackedProcesses.push(proc);
	proc.on("close", () => {
		const idx = trackedProcesses.indexOf(proc);
		if (idx >= 0) trackedProcesses.splice(idx, 1);
	});
	return proc;
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

function createDummyLLM(tempDir, responses) {
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

			// If any earlier assistant message already made a tool call, we are in the
			// follow-up turn (pi sent the tool result back to us).  Return plain text
			// so we don't loop forever.
			const alreadyCalledTool = context.messages.some(
				(m) =>
					m.role === "assistant" &&
					Array.isArray(m.content) &&
					m.content.some((c: any) => c.type === "toolCall"),
			);

			const lastUserMsg = context.messages.findLast((m) => m.role === "user");
			const userText =
				typeof lastUserMsg?.content === "string"
					? lastUserMsg.content
					: lastUserMsg?.content?.find((c) => c.type === "text")?.text ?? "";

			let response: any = responses.default || { text: "OK", toolCall: null };
			if (alreadyCalledTool) {
				response = { text: "Done.", toolCall: null };
			} else {
				for (const [key, value] of Object.entries(responses)) {
					if (userText.toLowerCase().includes(key.toLowerCase())) {
						response = value;
						break;
					}
				}
			}

			stream.push({ type: "start", partial: output });

			const textContent = { type: "text" as const, text: response.text };
			output.content.push(textContent);
			stream.push({ type: "text_start", contentIndex: 0, partial: output });
			stream.push({ type: "text_delta", contentIndex: 0, delta: response.text, partial: output });
			stream.push({ type: "text_end", contentIndex: 0, content: response.text, partial: output });

			if (response.toolCall) {
				output.stopReason = "toolUse";
				const toolCall = {
					...response.toolCall,
					type: "toolCall" as const,
					id: \`call_\${Date.now()}\`,
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

function initGitRepo(dir) {
	// Initialize git repo (synchronous to ensure correct ordering)
	spawnSync("git", ["init"], { cwd: dir, stdio: "ignore" });
	spawnSync("git", ["config", "user.name", "Test User"], { cwd: dir, stdio: "ignore" });
	spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" });
	
	// Create initial commit
	writeFileSync(join(dir, "README.md"), "# Test Repo\n", "utf-8");
	spawnSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
	spawnSync("git", ["commit", "-m", "Initial commit"], { cwd: dir, stdio: "ignore" });
}

async function runTest(name, testFn) {
	const tempDir = join(tmpdir(), `pi-artemis-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });
	
	try {
		// Initialize git repo with artemis
		initGitRepo(tempDir);
		
		// Initialize artemis
		const artemisInit = spawn("git", ["artemis", "list"], { cwd: tempDir, stdio: "pipe" });
		await new Promise(resolve => artemisInit.on("close", resolve));
		
		const result = await Promise.race([
			testFn(tempDir),
			new Promise((_, reject) =>
				setTimeout(() => reject(new Error("Test timeout")), 30000)
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
		// Kill any pi processes left running (e.g. from timeouts)
		const leftover = trackedProcesses.splice(0);
		for (const proc of leftover) {
			proc.kill("SIGKILL");
		}
		if (leftover.length > 0) {
			await new Promise(resolve => setTimeout(resolve, 500));
		}
		rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
	}
}

(async function() {
	// Test: List command works
	await runTest("List command executes successfully", async (tempDir) => {
		const dummyLLM = createDummyLLM(tempDir, {
			"list issues": {
				text: "Listing issues",
				toolCall: {
					name: "issues_list",
					arguments: {},
				}
			}
		});
		
		const extension = join(__dirname, "index.ts");
		const pi = startPi([dummyLLM, extension], tempDir);
		
		const events = [];
		const readline = createInterface({ input: pi.stdout });
		readline.on("line", (line) => {
			try {
				events.push(JSON.parse(line));
			} catch (e) {}
		});
		
		await new Promise(resolve => setTimeout(resolve, 500));
		sendCommand(pi, { type: "prompt", message: "list issues" });
		
		const toolStart = await waitForEvent(events,
			e => e.type === "tool_execution_start" && e.toolName === "issues_list"
		);
		
		const toolEnd = await waitForEvent(events,
			e => e.type === "tool_execution_end" && e.toolName === "issues_list"
		);
		
		pi.kill();
		await new Promise(resolve => pi.on("close", resolve));
		
		// Should succeed even with no issues
		return true;
	});

	// Test: Add issue creates new issue
	await runTest("Add command creates new issue", async (tempDir) => {
		const dummyLLM = createDummyLLM(tempDir, {
			"new issue": {
				text: "Creating issue",
				toolCall: {
					name: "issues_new",
					arguments: {
						subject: "Test Bug",
						body: "This is a test issue for the integration test",
					}
				}
			}
		});
		
		const extension = join(__dirname, "index.ts");
		const pi = startPi([dummyLLM, extension], tempDir);
		
		const events = [];
		const readline = createInterface({ input: pi.stdout });
		readline.on("line", (line) => {
			try {
				events.push(JSON.parse(line));
			} catch (e) {}
		});
		
		await new Promise(resolve => setTimeout(resolve, 500));
		sendCommand(pi, { type: "prompt", message: "new issue" });
		
		const toolEnd = await waitForEvent(events,
			e => e.type === "tool_execution_end" && e.toolName === "issues_new"
		);
		
		pi.kill();
		await new Promise(resolve => pi.on("close", resolve));
		
		// Check if issue was created by listing issues
		const listResult = spawn("git", ["artemis", "list", "-a"], {
			cwd: tempDir,
			stdio: "pipe"
		});
		
		let output = "";
		listResult.stdout.on("data", (data) => {
			output += data.toString();
		});
		
		await new Promise(resolve => listResult.on("close", resolve));
		
		if (!output.includes("Test Bug")) {
			return "Issue was not created";
		}
		
		return true;
	});

	// Test: Show command displays issue
	await runTest("Show command displays issue", async (tempDir) => {
		// First create an issue
		const addResult = spawn("git", ["artemis", "add", "-m", "Show Test Issue"], {
			cwd: tempDir,
			stdio: "pipe",
			env: { ...process.env, EDITOR: "true" }
		});
		
		let issueId = "";
		addResult.stdout.on("data", (data) => {
			const match = data.toString().match(/([a-f0-9]{16})/);
			if (match) issueId = match[1];
		});
		
		await new Promise(resolve => addResult.on("close", resolve));
		
		if (!issueId) {
			return "Failed to create test issue";
		}
		
		// Now test show command
		const dummyLLM = createDummyLLM(tempDir, {
			"show issue": {
				text: "Showing issue",
				toolCall: {
					name: "issues_show",
					arguments: {
						issueId: issueId,
					}
				}
			}
		});
		
		const extension = join(__dirname, "index.ts");
		const pi = startPi([dummyLLM, extension], tempDir);
		
		const events = [];
		const readline = createInterface({ input: pi.stdout });
		readline.on("line", (line) => {
			try {
				events.push(JSON.parse(line));
			} catch (e) {}
		});
		
		await new Promise(resolve => setTimeout(resolve, 500));
		sendCommand(pi, { type: "prompt", message: "show issue" });
		
		const toolEnd = await waitForEvent(events,
			e => e.type === "tool_execution_end" && e.toolName === "issues_show"
		);
		
		pi.kill();
		await new Promise(resolve => pi.on("close", resolve));
		
		// Verify the result contains issue info
		const resultText = toolEnd.result?.content?.[0]?.text || "";
		if (!resultText.includes("Show Test Issue")) {
			return "Show result doesn't contain issue subject";
		}
		
		return true;
	});

	// Test: Close command closes issue
	await runTest("Close command closes issue", async (tempDir) => {
		// First create an issue
		const addResult = spawn("git", ["artemis", "add", "-m", "Close Test Issue"], {
			cwd: tempDir,
			stdio: "pipe",
			env: { ...process.env, EDITOR: "true" }
		});
		
		let issueId = "";
		addResult.stdout.on("data", (data) => {
			const match = data.toString().match(/([a-f0-9]{16})/);
			if (match) issueId = match[1];
		});
		
		await new Promise(resolve => addResult.on("close", resolve));
		
		if (!issueId) {
			return "Failed to create test issue";
		}
		
		// Now test close command
		const dummyLLM = createDummyLLM(tempDir, {
			"close issue": {
				text: "Closing issue",
				toolCall: {
					name: "issues_close",
					arguments: {
						issueId: issueId,
						body: "Closing in integration test",
					}
				}
			}
		});
		
		const extension = join(__dirname, "index.ts");
		const pi = startPi([dummyLLM, extension], tempDir);
		
		const events = [];
		const readline = createInterface({ input: pi.stdout });
		readline.on("line", (line) => {
			try {
				events.push(JSON.parse(line));
			} catch (e) {}
		});
		
		await new Promise(resolve => setTimeout(resolve, 500));
		sendCommand(pi, { type: "prompt", message: "close issue" });
		
		await waitForEvent(events,
			e => e.type === "tool_execution_end" && e.toolName === "issues_close"
		);
		
		pi.kill();
		await new Promise(resolve => pi.on("close", resolve));
		
		// Verify issue is closed (not in default list)
		const listResult = spawn("git", ["artemis", "list"], {
			cwd: tempDir,
			stdio: "pipe"
		});
		
		let output = "";
		listResult.stdout.on("data", (data) => {
			output += data.toString();
		});
		
		await new Promise(resolve => listResult.on("close", resolve));
		
		if (output.includes(issueId)) {
			return "Issue still appears in default list (not closed)";
		}
		
		return true;
	});

	// Test: List with all flag shows all issues
	await runTest("List with all flag shows closed issues", async (tempDir) => {
		// Create and close an issue
		const addResult = spawn("git", ["artemis", "add", "-m", "Closed Issue"], {
			cwd: tempDir,
			stdio: "pipe",
			env: { ...process.env, EDITOR: "true" }
		});
		
		let issueId = "";
		addResult.stdout.on("data", (data) => {
			const match = data.toString().match(/([a-f0-9]{16})/);
			if (match) issueId = match[1];
		});
		
		await new Promise(resolve => addResult.on("close", resolve));
		
		if (!issueId) {
			return "Failed to create test issue";
		}
		
		// Close it
		const closeResult = spawn("git", ["artemis", "add", issueId, "-p", "state=resolved", "-p", "resolution=fixed", "-n"], {
			cwd: tempDir,
			stdio: "pipe"
		});
		await new Promise(resolve => closeResult.on("close", resolve));
		
		// Test list with all=true
		const dummyLLM = createDummyLLM(tempDir, {
			"list all": {
				text: "Listing all issues",
				toolCall: {
					name: "issues_list",
					arguments:{
						all: true,
					}
				}
			}
		});
		
		const extension = join(__dirname, "index.ts");
		const pi = startPi([dummyLLM, extension], tempDir);
		
		const events = [];
		const readline = createInterface({ input: pi.stdout });
		readline.on("line", (line) => {
			try {
				events.push(JSON.parse(line));
			} catch (e) {}
		});
		
		await new Promise(resolve => setTimeout(resolve, 500));
		sendCommand(pi, { type: "prompt", message: "list all" });
		
		const toolEnd = await waitForEvent(events,
			e => e.type === "tool_execution_end" && e.toolName === "issues_list"
		);
		
		pi.kill();
		await new Promise(resolve => pi.on("close", resolve));
		
		const resultText = toolEnd.result?.content?.[0]?.text || "";
		if (!resultText.includes(issueId)) {
			return "Closed issue should appear in list with all=true";
		}
		
		return true;
	});

	// Test: Issue body is stored and retrievable
	await runTest("Add command stores issue body text", async (tempDir) => {
		const testBody = "This is the detailed body text.\nIt has multiple lines.\nAnd should be stored in the issue.";
		
		const dummyLLM = createDummyLLM(tempDir, {
			"create issue": {
				text: "Creating issue with body",
				toolCall: {
					name: "issues_new",
					arguments: {
						subject: "Body Test Issue",
						body: testBody,
					}
				}
			}
		});
		
		const extension = join(__dirname, "index.ts");
		const pi = startPi([dummyLLM, extension], tempDir);
		
		const events = [];
		const readline = createInterface({ input: pi.stdout });
		readline.on("line", (line) => {
			try {
				events.push(JSON.parse(line));
			} catch (e) {}
		});
		
		await new Promise(resolve => setTimeout(resolve, 500));
		sendCommand(pi, { type: "prompt", message: "create issue" });
		
		const toolEnd = await waitForEvent(events,
			e => e.type === "tool_execution_end" && e.toolName === "issues_new"
		);
		
		pi.kill();
		await new Promise(resolve => pi.on("close", resolve));
		
		// Extract issue ID from result
		const resultText = toolEnd.result?.content?.[0]?.text || "";
		const issueIdMatch = resultText.match(/([a-f0-9]{16})/);
		
		if (!issueIdMatch) {
			return "Failed to extract issue ID from result";
		}
		
		const issueId = issueIdMatch[1];
		
		// Now verify the body is stored by showing the issue
		const showResult = spawn("git", ["artemis", "show", issueId], {
			cwd: tempDir,
			stdio: "pipe"
		});
		
		let output = "";
		showResult.stdout.on("data", (data) => {
			output += data.toString();
		});
		
		await new Promise(resolve => showResult.on("close", resolve));
		
		// Check that the body text appears in the output
		if (!output.includes("This is the detailed body text.")) {
			return `Body text not found in show output. Output was:\n${output}`;
		}
		
		if (!output.includes("It has multiple lines.")) {
			return `Body text incomplete in show output. Output was:\n${output}`;
		}
		
		return true;
	});

	// Test: Show command returns issue body
	await runTest("Show command displays issue body in tool result", async (tempDir) => {
		const testBody = "Critical bug in authentication module.\n\nSteps to reproduce:\n1. Login as admin\n2. Navigate to settings\n3. System crashes";
		
		const dummyLLM = createDummyLLM(tempDir, {
			"create issue with body": {
				text: "Creating issue",
				toolCall: {
					name: "issues_new",
					arguments: {
						subject: "Auth Bug",
						body: testBody,
					}
				}
			},
			"show the issue": {
				text: "Showing issue",
				toolCall: {
					name: "issues_show",
					arguments: {
						issueId: "placeholder", // Will be replaced below
					}
				}
			}
		});
		
		const extension = join(__dirname, "index.ts");
		const pi = startPi([dummyLLM, extension], tempDir);
		
		const events = [];
		const readline = createInterface({ input: pi.stdout });
		readline.on("line", (line) => {
			try {
				events.push(JSON.parse(line));
			} catch (e) {}
		});
		
		await new Promise(resolve => setTimeout(resolve, 500));
		
		// Create the issue
		sendCommand(pi, { type: "prompt", message: "create issue with body" });
		
		const addEnd = await waitForEvent(events,
			e => e.type === "tool_execution_end" && e.toolName === "issues_new"
		);
		
		// Extract issue ID
		const resultText = addEnd.result?.content?.[0]?.text || "";
		const issueIdMatch = resultText.match(/([a-f0-9]{16})/);
		
		if (!issueIdMatch) {
			pi.kill();
			await new Promise(resolve => pi.on("close", resolve));
			return "Failed to extract issue ID from add result";
		}
		
		const issueId = issueIdMatch[1];
		
		// Update the dummy LLM to use the actual issue ID
		const showLLM = createDummyLLM(tempDir, {
			"show the issue": {
				text: "Showing issue",
				toolCall: {
					name: "issues_show",
					arguments: {
						issueId: issueId,
					}
				}
			}
		});
		
		// Restart pi with updated LLM
		pi.kill();
		await new Promise(resolve => pi.on("close", resolve));
		
		const pi2 = startPi([showLLM, extension], tempDir);
		const events2 = [];
		const readline2 = createInterface({ input: pi2.stdout });
		readline2.on("line", (line) => {
			try {
				events2.push(JSON.parse(line));
			} catch (e) {}
		});
		
		await new Promise(resolve => setTimeout(resolve, 500));
		
		// Show the issue
		sendCommand(pi2, { type: "prompt", message: "show the issue" });
		
		const showEnd = await waitForEvent(events2,
			e => e.type === "tool_execution_end" && e.toolName === "issues_show"
		);
		
		pi2.kill();
		await new Promise(resolve => pi2.on("close", resolve));
		
		// Verify the body appears in the show result
		const showOutput = showEnd.result?.content?.[0]?.text || "";
		
		if (!showOutput.includes("Critical bug in authentication module")) {
			return `Body text not in show result. Result was:\n${showOutput}`;
		}
		
		if (!showOutput.includes("Steps to reproduce:")) {
			return `Body text incomplete in show result. Result was:\n${showOutput}`;
		}
		
		return true;
	});

	// Test: Comment body is stored and retrievable
	await runTest("Add comment stores comment body text", async (tempDir) => {
		// First create an issue
		const addResult = spawn("git", ["artemis", "add", "-m", "Comment Test Issue"], {
			cwd: tempDir,
			stdio: "pipe",
			env: { ...process.env, EDITOR: "true" }
		});
		
		let issueId = "";
		addResult.stdout.on("data", (data) => {
			const match = data.toString().match(/([a-f0-9]{16})/);
			if (match) issueId = match[1];
		});
		
		await new Promise(resolve => addResult.on("close", resolve));
		
		if (!issueId) {
			return "Failed to create test issue";
		}
		
		// Now add a comment with body
		const commentBody = "I found the root cause.\n\nThe issue is in line 42 of auth.js.\nWe need to add null checking.";
		
		const dummyLLM = createDummyLLM(tempDir, {
			"add comment": {
				text: "Adding comment",
				toolCall: {
					name: "issues_comment",
					arguments: {
						issueId: issueId,
						body: commentBody,
					}
				}
			}
		});
		
		const extension = join(__dirname, "index.ts");
		const pi = startPi([dummyLLM, extension], tempDir);
		
		const events = [];
		const readline = createInterface({ input: pi.stdout });
		readline.on("line", (line) => {
			try {
				events.push(JSON.parse(line));
			} catch (e) {}
		});
		
		await new Promise(resolve => setTimeout(resolve, 500));
		sendCommand(pi, { type: "prompt", message: "add comment" });
		
		await waitForEvent(events,
			e => e.type === "tool_execution_end" && e.toolName === "issues_comment"
		);
		
		pi.kill();
		await new Promise(resolve => pi.on("close", resolve));
		
		// Verify the comment body is stored by showing comment 1 (first comment)
		const showResult = spawn("git", ["artemis", "show", issueId, "1"], {
			cwd: tempDir,
			stdio: "pipe"
		});
		
		let output = "";
		showResult.stdout.on("data", (data) => {
			output += data.toString();
		});
		
		await new Promise(resolve => showResult.on("close", resolve));
		
		// Check that the comment body text appears
		if (!output.includes("I found the root cause.")) {
			return `Comment body not found in show output. Output was:\n${output}`;
		}
		
		if (!output.includes("The issue is in line 42 of auth.js.")) {
			return `Comment body incomplete in show output. Output was:\n${output}`;
		}
		
		return true;
	});

	process.exit(failCount > 0 ? 1 : 0);
})();
