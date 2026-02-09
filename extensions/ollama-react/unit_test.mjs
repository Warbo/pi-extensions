#!/usr/bin/env node
/**
 * Unit tests for ollama-react extension
 * Tests the ReAct response parser in isolation.
 */

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

function runTest(name, fn) {
	try {
		fn();
		testPass(name);
	} catch (e) {
		testFail(name, e.message);
	}
}

function eq(a, b) {
	const sa = JSON.stringify(a);
	const sb = JSON.stringify(b);
	if (sa !== sb) throw new Error(`Expected ${sb}, got ${sa}`);
}

// -----------------------------------------------------------------------
// Re-implement the parser from index.ts so we can test it without
// importing TypeScript directly.  (The nix build environment has node
// but not a TS loader for .ts → .mjs at test time.)
// -----------------------------------------------------------------------

function looksLikeToolCall(lines, start) {
	let peek = "";
	for (let j = start; j < lines.length && peek.length < 500; j++) {
		peek += lines[j] + "\n";
	}
	return /"\s*name\s*"\s*:/.test(peek);
}

function extractJsonObject(lines, start) {
	let depth = 0;
	let json = "";
	let endIndex = start;
	for (let j = start; j < lines.length; j++) {
		json += (j > start ? "\n" : "") + lines[j];
		for (const ch of lines[j]) {
			if (ch === "{") depth++;
			if (ch === "}") depth--;
		}
		endIndex = j;
		if (depth <= 0) break;
	}
	return { json: json.trim(), endIndex };
}

function parseReActResponse(text) {
	const blocks = [];
	const lines = text.split("\n");
	let i = 0;

	while (i < lines.length) {
		const line = lines[i];

		// THOUGHT block
		if (/^\s*THOUGHT:\s*/i.test(line)) {
			const thoughtLines = [line.replace(/^\s*THOUGHT:\s*/i, "")];
			i++;
			while (i < lines.length) {
				if (/^\s*THOUGHT:\s*/i.test(lines[i])) break;
				if (/^\s*\{/.test(lines[i]) && looksLikeToolCall(lines, i)) break;
				thoughtLines.push(lines[i]);
				i++;
			}
			const content = thoughtLines.join("\n").trim();
			if (content) blocks.push({ type: "thought", content });
			continue;
		}

		// JSON tool call
		if (/^\s*\{/.test(line) && looksLikeToolCall(lines, i)) {
			const { json, endIndex } = extractJsonObject(lines, i);
			i = endIndex + 1;
			try {
				const parsed = JSON.parse(json);
				if (parsed.name && parsed.arguments !== undefined) {
					blocks.push({
						type: "tool_call",
						content: json,
						toolName: parsed.name,
						toolArgs:
							typeof parsed.arguments === "string"
								? JSON.parse(parsed.arguments)
								: parsed.arguments,
					});
					continue;
				}
			} catch {
				// not valid JSON
			}
			blocks.push({ type: "text", content: json });
			continue;
		}

		// Plain text
		const textLines = [line];
		i++;
		while (i < lines.length) {
			if (/^\s*THOUGHT:\s*/i.test(lines[i])) break;
			if (/^\s*\{/.test(lines[i]) && looksLikeToolCall(lines, i)) break;
			textLines.push(lines[i]);
			i++;
		}
		const content = textLines.join("\n").trim();
		if (content) blocks.push({ type: "text", content });
	}

	return blocks;
}

// -----------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------

runTest("Plain text only", () => {
	const blocks = parseReActResponse("Hello, world!");
	eq(blocks.length, 1);
	eq(blocks[0].type, "text");
	eq(blocks[0].content, "Hello, world!");
});

runTest("Multi-line plain text", () => {
	const blocks = parseReActResponse("Line one\nLine two\nLine three");
	eq(blocks.length, 1);
	eq(blocks[0].type, "text");
	eq(blocks[0].content, "Line one\nLine two\nLine three");
});

runTest("Single THOUGHT block", () => {
	const blocks = parseReActResponse("THOUGHT: I need to check the files");
	eq(blocks.length, 1);
	eq(blocks[0].type, "thought");
	eq(blocks[0].content, "I need to check the files");
});

runTest("THOUGHT is case-insensitive", () => {
	const blocks = parseReActResponse("thought: lower case works too");
	eq(blocks.length, 1);
	eq(blocks[0].type, "thought");
	eq(blocks[0].content, "lower case works too");
});

runTest("Thought: mixed case", () => {
	const blocks = parseReActResponse("Thought: Mixed case");
	eq(blocks.length, 1);
	eq(blocks[0].type, "thought");
	eq(blocks[0].content, "Mixed case");
});

runTest("Multi-line THOUGHT block", () => {
	const input = "THOUGHT: First line\nSecond line\nThird line";
	const blocks = parseReActResponse(input);
	eq(blocks.length, 1);
	eq(blocks[0].type, "thought");
	eq(blocks[0].content, "First line\nSecond line\nThird line");
});

runTest("Single tool call", () => {
	const input = '{"name": "bash", "arguments": {"command": "ls -la"}}';
	const blocks = parseReActResponse(input);
	eq(blocks.length, 1);
	eq(blocks[0].type, "tool_call");
	eq(blocks[0].toolName, "bash");
	eq(blocks[0].toolArgs.command, "ls -la");
});

runTest("Multi-line tool call", () => {
	const input = [
		"{",
		'  "name": "read",',
		'  "arguments": {',
		'    "path": "src/index.ts"',
		"  }",
		"}",
	].join("\n");
	const blocks = parseReActResponse(input);
	eq(blocks.length, 1);
	eq(blocks[0].type, "tool_call");
	eq(blocks[0].toolName, "read");
	eq(blocks[0].toolArgs.path, "src/index.ts");
});

runTest("Tool call with string arguments (double-encoded)", () => {
	const input =
		'{"name": "bash", "arguments": "{\\"command\\": \\"echo hello\\"}"}';
	const blocks = parseReActResponse(input);
	eq(blocks.length, 1);
	eq(blocks[0].type, "tool_call");
	eq(blocks[0].toolName, "bash");
	eq(blocks[0].toolArgs.command, "echo hello");
});

runTest("THOUGHT then tool call", () => {
	const input = [
		"THOUGHT: I should list the files first",
		'{"name": "bash", "arguments": {"command": "ls"}}',
	].join("\n");
	const blocks = parseReActResponse(input);
	eq(blocks.length, 2);
	eq(blocks[0].type, "thought");
	eq(blocks[0].content, "I should list the files first");
	eq(blocks[1].type, "tool_call");
	eq(blocks[1].toolName, "bash");
});

runTest("Text then THOUGHT then tool call", () => {
	const input = [
		"Let me help you with that.",
		"THOUGHT: I need to read the file to understand the code",
		'{"name": "read", "arguments": {"path": "main.py"}}',
	].join("\n");
	const blocks = parseReActResponse(input);
	eq(blocks.length, 3);
	eq(blocks[0].type, "text");
	eq(blocks[0].content, "Let me help you with that.");
	eq(blocks[1].type, "thought");
	eq(blocks[2].type, "tool_call");
	eq(blocks[2].toolName, "read");
});

runTest("Multiple THOUGHT blocks", () => {
	const input = [
		"THOUGHT: First I'll check the structure",
		"THOUGHT: Then I'll edit the file",
	].join("\n");
	const blocks = parseReActResponse(input);
	eq(blocks.length, 2);
	eq(blocks[0].type, "thought");
	eq(blocks[0].content, "First I'll check the structure");
	eq(blocks[1].type, "thought");
	eq(blocks[1].content, "Then I'll edit the file");
});

runTest("Multiple tool calls", () => {
	const input = [
		'{"name": "bash", "arguments": {"command": "ls"}}',
		'{"name": "read", "arguments": {"path": "foo.txt"}}',
	].join("\n");
	const blocks = parseReActResponse(input);
	eq(blocks.length, 2);
	eq(blocks[0].type, "tool_call");
	eq(blocks[0].toolName, "bash");
	eq(blocks[1].type, "tool_call");
	eq(blocks[1].toolName, "read");
});

runTest("THOUGHT, tool call, text, THOUGHT, tool call", () => {
	const input = [
		"THOUGHT: Let me check",
		'{"name": "bash", "arguments": {"command": "ls"}}',
		"Now I see the files.",
		"THOUGHT: I should read the config",
		'{"name": "read", "arguments": {"path": "config.json"}}',
	].join("\n");
	const blocks = parseReActResponse(input);
	eq(blocks.length, 5);
	eq(blocks[0].type, "thought");
	eq(blocks[1].type, "tool_call");
	eq(blocks[1].toolName, "bash");
	eq(blocks[2].type, "text");
	eq(blocks[2].content, "Now I see the files.");
	eq(blocks[3].type, "thought");
	eq(blocks[4].type, "tool_call");
	eq(blocks[4].toolName, "read");
});

runTest("Empty input produces no blocks", () => {
	const blocks = parseReActResponse("");
	eq(blocks.length, 0);
});

runTest("Whitespace-only input produces no blocks", () => {
	const blocks = parseReActResponse("   \n  \n   ");
	eq(blocks.length, 0);
});

runTest("Empty THOUGHT with continuation becomes thought", () => {
	// "THOUGHT: \nSome text" — the continuation line belongs to the thought
	const input = "THOUGHT: \nSome text after";
	const blocks = parseReActResponse(input);
	eq(blocks.length, 1);
	eq(blocks[0].type, "thought");
	eq(blocks[0].content, "Some text after");
});

runTest("Truly empty THOUGHT is skipped", () => {
	// THOUGHT with nothing after it and next line is another block type
	const input = "THOUGHT: \nTHOUGHT: real thought";
	const blocks = parseReActResponse(input);
	eq(blocks.length, 1);
	eq(blocks[0].type, "thought");
	eq(blocks[0].content, "real thought");
});

runTest("JSON without 'name' key is plain text", () => {
	const input = '{"key": "value", "other": 42}';
	const blocks = parseReActResponse(input);
	eq(blocks.length, 1);
	eq(blocks[0].type, "text");
});

runTest("Invalid JSON that looks like a tool call is plain text", () => {
	const input = '{"name": "bash", "arguments": {bad json}}';
	const blocks = parseReActResponse(input);
	eq(blocks.length, 1);
	eq(blocks[0].type, "text");
});

runTest("Leading whitespace on THOUGHT line", () => {
	const input = "  THOUGHT: indented thought";
	const blocks = parseReActResponse(input);
	eq(blocks.length, 1);
	eq(blocks[0].type, "thought");
	eq(blocks[0].content, "indented thought");
});

runTest("Leading whitespace on JSON line", () => {
	const input = '  {"name": "bash", "arguments": {"command": "pwd"}}';
	const blocks = parseReActResponse(input);
	eq(blocks.length, 1);
	eq(blocks[0].type, "tool_call");
	eq(blocks[0].toolName, "bash");
});

runTest("Tool call with nested JSON in arguments", () => {
	const input = JSON.stringify({
		name: "write",
		arguments: {
			path: "data.json",
			content: '{"nested": {"deep": true}}',
		},
	});
	const blocks = parseReActResponse(input);
	eq(blocks.length, 1);
	eq(blocks[0].type, "tool_call");
	eq(blocks[0].toolName, "write");
	eq(blocks[0].toolArgs.path, "data.json");
});

runTest("Tool call with empty arguments object", () => {
	const input = '{"name": "bash", "arguments": {}}';
	const blocks = parseReActResponse(input);
	eq(blocks.length, 1);
	eq(blocks[0].type, "tool_call");
	eq(blocks[0].toolName, "bash");
	eq(JSON.stringify(blocks[0].toolArgs), "{}");
});

runTest("Realistic multi-turn ReAct response", () => {
	const input = [
		"THOUGHT: The user wants to fix a bug in the parser. I should first",
		"read the relevant source file to understand the current code.",
		"",
		'{"name": "read", "arguments": {"path": "src/parser.ts"}}',
	].join("\n");
	const blocks = parseReActResponse(input);
	eq(blocks.length, 2);
	eq(blocks[0].type, "thought");
	// Thought should include the continuation line
	if (!blocks[0].content.includes("read the relevant source file")) {
		throw new Error("Thought didn't include continuation line");
	}
	eq(blocks[1].type, "tool_call");
	eq(blocks[1].toolName, "read");
	eq(blocks[1].toolArgs.path, "src/parser.ts");
});

runTest("JSON object with 'name' key but no 'arguments' is text", () => {
	const input = '{"name": "just a name, no arguments field"}';
	const blocks = parseReActResponse(input);
	eq(blocks.length, 1);
	// Should be text since there's no 'arguments' key
	eq(blocks[0].type, "text");
});

runTest("edit tool call with multi-line content", () => {
	const input = JSON.stringify({
		name: "edit",
		arguments: {
			path: "src/main.ts",
			oldText: "function old() {\n  return 1;\n}",
			newText: "function updated() {\n  return 2;\n}",
		},
	});
	const blocks = parseReActResponse(input);
	eq(blocks.length, 1);
	eq(blocks[0].type, "tool_call");
	eq(blocks[0].toolName, "edit");
	eq(blocks[0].toolArgs.path, "src/main.ts");
	if (!blocks[0].toolArgs.oldText.includes("function old()")) {
		throw new Error("oldText not parsed correctly");
	}
});

// -----------------------------------------------------------------------
// looksLikeToolCall edge cases
// -----------------------------------------------------------------------

runTest("looksLikeToolCall: false for plain object", () => {
	const lines = ['{"key": "value"}'];
	eq(looksLikeToolCall(lines, 0), false);
});

runTest("looksLikeToolCall: true for tool-shaped object", () => {
	const lines = ['{"name": "bash", "arguments": {}}'];
	eq(looksLikeToolCall(lines, 0), true);
});

runTest("looksLikeToolCall: true with spaced name key", () => {
	const lines = ['{  "name"  :  "read" }'];
	eq(looksLikeToolCall(lines, 0), true);
});

// -----------------------------------------------------------------------
// extractJsonObject edge cases
// -----------------------------------------------------------------------

runTest("extractJsonObject: single-line", () => {
	const lines = ['{"a": 1}'];
	const { json, endIndex } = extractJsonObject(lines, 0);
	eq(json, '{"a": 1}');
	eq(endIndex, 0);
});

runTest("extractJsonObject: multi-line nested", () => {
	const lines = ["{", '  "a": {', '    "b": 1', "  }", "}"];
	const { json, endIndex } = extractJsonObject(lines, 0);
	eq(endIndex, 4);
	const parsed = JSON.parse(json);
	eq(parsed.a.b, 1);
});

runTest("extractJsonObject: stops at balanced brace", () => {
	const lines = ['{"x": 1}', "trailing text"];
	const { json, endIndex } = extractJsonObject(lines, 0);
	eq(json, '{"x": 1}');
	eq(endIndex, 0);
});

// -----------------------------------------------------------------------

if (failures > 0) {
	console.log(`\n${failures} test(s) failed`);
	process.exit(1);
} else {
	console.log("\nAll tests passed");
}
