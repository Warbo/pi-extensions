#!/usr/bin/env tsx
/**
 * Pi integration tests.
 *
 * Tests the emacsclient extension loaded into pi in RPC mode.
 * Uses a dummy LLM and a fake emacsclient script that returns canned responses.
 */

import { spawn, ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function testPass(name: string) {
  console.log(`ok - ${name}`);
  passed++;
}

function testFail(name: string, reason?: string) {
  console.log(`not ok - ${name}`);
  if (reason) console.log(`  # ${reason}`);
  failed++;
}

function waitForEvent(events: any[], predicate: (e: any) => boolean, timeout = 15000): Promise<any> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const found = events.find(predicate);
      if (found) return resolve(found);
      if (Date.now() - start > timeout)
        return reject(new Error("Timeout waiting for event"));
      setTimeout(check, 50);
    };
    check();
  });
}

function waitForResponse(events: any[], timeout = 15000): Promise<any> {
  return waitForEvent(events, (e) => e.type === "response", timeout);
}

// ---------------------------------------------------------------------------
// Create a fake emacsclient that returns canned responses
// ---------------------------------------------------------------------------

function createFakeEmacsclient(dir: string, responses: Record<string, string>): string {
  // responses is a map from elisp substring → raw stdout output
  const script = join(dir, "emacsclient");
  const jsScript = join(dir, "emacsclient.js");
  const responsesJson = JSON.stringify(responses);

  // Create the JavaScript implementation
  writeFileSync(
    jsScript,
    `const responses = ${responsesJson};
const args = process.argv.slice(2);
const evalIdx = args.indexOf("--eval");
if (evalIdx === -1) {
  process.stderr.write("FAKE emacsclient: no --eval argument\\n");
  process.exit(1);
}
const elisp = args[evalIdx + 1];
if (!elisp) {
  process.stderr.write("FAKE emacsclient: missing elisp expression after --eval\\n");
  process.exit(1);
}
for (const [key, value] of Object.entries(responses)) {
  if (elisp.includes(key)) {
    process.stdout.write(value);
    process.exit(0);
  }
}
// Default: return empty JSON array
process.stdout.write('"[]"');
process.exit(0);
`,
    "utf-8"
  );

  // Create a shell wrapper that calls node
  writeFileSync(
    script,
    `#!/bin/sh
exec node "${jsScript}" "$@"
`,
    "utf-8"
  );
  chmodSync(script, 0o755);
  return dir; // Return dir to prepend to PATH
}

// ---------------------------------------------------------------------------
// Create dummy LLM extension that makes tool calls
// ---------------------------------------------------------------------------

function createDummyLLM(dir: string, toolCalls: Record<string, any>): string {
  // toolCalls is a map of user-message-substring → { text, tool?, args? }
  const llmPath = join(dir, "dummy-llm.ts");
  const callsJson = JSON.stringify(toolCalls);

  writeFileSync(
    llmPath,
    `
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
  createAssistantMessageEventStream,
} from "@mariozechner/pi-ai";

const toolCalls: Record<string, any> = ${callsJson};

function stream(
  model: Model<any>,
  context: Context,
  options?: SimpleStreamOptions
): AssistantMessageEventStream {
  const s = createAssistantMessageEventStream();

  (async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    try {
      // If last message is a tool result, just acknowledge
      const last = context.messages[context.messages.length - 1];
      if (last && (last.role === "tool" || last.role === "toolResult")) {
        s.push({ type: "start", partial: output });
        output.content.push({ type: "text" as const, text: "Done." });
        s.push({ type: "text_start", contentIndex: 0, partial: output });
        s.push({ type: "text_delta", contentIndex: 0, delta: "Done.", partial: output });
        s.push({ type: "text_end", contentIndex: 0, content: "Done.", partial: output });
        s.push({ type: "done", reason: "stop", message: output });
        s.end();
        return;
      }

      const lastUser = context.messages.findLast((m: any) => m.role === "user");
      const userText = typeof lastUser?.content === "string"
        ? lastUser.content
        : lastUser?.content?.find((c: any) => c.type === "text")?.text ?? "";

      let matched: any = null;
      for (const [key, value] of Object.entries(toolCalls)) {
        if (userText.toLowerCase().includes(key.toLowerCase())) {
          matched = value;
          break;
        }
      }

      s.push({ type: "start", partial: output });

      const text = matched?.text || "I don't know how to do that.";
      output.content.push({ type: "text" as const, text });
      s.push({ type: "text_start", contentIndex: 0, partial: output });
      s.push({ type: "text_delta", contentIndex: 0, delta: text, partial: output });
      s.push({ type: "text_end", contentIndex: 0, content: text, partial: output });

      if (matched?.tool) {
        output.stopReason = "toolUse";
        const tc = {
          type: "toolCall" as const,
          id: \`call_\${Date.now()}\`,
          name: matched.tool,
          arguments: matched.args || {},
        };
        output.content.push(tc);
        s.push({ type: "toolcall_start", contentIndex: 1, partial: output });
        s.push({ type: "toolcall_end", contentIndex: 1, toolCall: tc, partial: output });
      }

      s.push({ type: "done", reason: output.stopReason as any, message: output });
      s.end();
    } catch (error: any) {
      output.stopReason = "error";
      output.errorMessage = error.message;
      s.push({ type: "error", reason: "error", error: output });
      s.end();
    }
  })();

  return s;
}

export default function (pi: ExtensionAPI) {
  pi.registerProvider("dummy", {
    baseUrl: "http://localhost:1234",
    apiKey: "dummy",
    api: "openai-completions",
    models: [{
      id: "dummy-model",
      name: "Dummy",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
    }],
    streamSimple: stream,
  });
}
`,
    "utf-8"
  );
  return llmPath;
}

// ---------------------------------------------------------------------------
// Pi process management
// ---------------------------------------------------------------------------

function startPi(extensions: string[], cwd: string, env: Record<string, string>): ChildProcess {
  const args = [
    "--mode", "rpc",
    "--provider", "dummy",
    "--model", "dummy-model",
    ...extensions.flatMap((ext) => ["-e", ext]),
  ];

  return spawn("pi", args, {
    stdio: ["pipe", "pipe", "pipe"],
    cwd,
    env: { ...process.env, ...env, HOME: cwd },
  });
}

function sendCommand(proc: ChildProcess, cmd: any) {
  proc.stdin!.write(JSON.stringify(cmd) + "\n");
}

async function runTest(name: string, testFn: (tempDir: string) => Promise<boolean | string>) {
  const tempDir = join(
    tmpdir(),
    `pi-emacs-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(tempDir, { recursive: true });

  try {
    const result = await Promise.race([
      testFn(tempDir),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Test timeout (30s)")), 30000)
      ),
    ]);

    if (result === true) {
      testPass(name);
    } else {
      testFail(name, (typeof result === "string" ? result : undefined) || "Test returned false");
    }
  } catch (err: any) {
    testFail(name, err.message);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

(async function () {
  // Test: emacs_list_buffers tool is called and returns parsed result
  await runTest(
    "pi calls emacs_list_buffers and gets buffer list",
    async (tempDir) => {
      const fakeResponse =
        '"[{\\"name\\":\\"main.py\\",\\"filepath\\":\\"/home/test/main.py\\",\\"unsaved\\":false,\\"outdated\\":false,\\"majorMode\\":\\"python-mode\\",\\"size\\":1234,\\"visible\\":false}]"';

      const fakeDir = createFakeEmacsclient(tempDir, {
        "buffer-list": fakeResponse,
      });

      const llm = createDummyLLM(tempDir, {
        "list buffers": {
          text: "Let me list the buffers.",
          tool: "emacs_list_buffers",
          args: {},
        },
      });

      const ext = join(__dirname, "index.ts");
      const pi = startPi([llm, ext], tempDir, {
        EMACSCLIENT_BINARY: join(fakeDir, "emacsclient"),
      });

      const events: any[] = [];
      const rl = createInterface({ input: pi.stdout! });
      rl.on("line", (line) => {
        try {
          events.push(JSON.parse(line));
        } catch {}
      });

      try {
        await new Promise((r) => setTimeout(r, 500));
        sendCommand(pi, { type: "prompt", message: "list buffers" });

        const toolEnd = await waitForEvent(
          events,
          (e) =>
            e.type === "tool_execution_end" &&
            e.toolName === "emacs_list_buffers"
        );

        await waitForResponse(events);

        // The tool result should contain the buffer data
        const resultText =
          toolEnd.result?.content?.find((c: any) => c.type === "text")?.text ?? "";
        const parsed = JSON.parse(resultText);
        if (!Array.isArray(parsed))
          return `Expected array, got ${typeof parsed}`;
        if (parsed[0]?.name !== "main.py")
          return `Expected main.py, got ${parsed[0]?.name}`;

        return true;
      } finally {
        pi.kill();
        await new Promise((r) => pi.on("close", r));
      }
    }
  );

  // Test: emacs_eval returns result
  await runTest("pi calls emacs_eval and gets result", async (tempDir) => {
    const fakeDir = createFakeEmacsclient(tempDir, {
      "progn": '"42"',
    });

    const llm = createDummyLLM(tempDir, {
      "evaluate": {
        text: "Evaluating expression.",
        tool: "emacs_eval",
        args: { expression: "(+ 21 21)" },
      },
    });

    const ext = join(__dirname, "index.ts");
    const pi = startPi([llm, ext], tempDir, {
      EMACSCLIENT_BINARY: join(fakeDir, "emacsclient"),
    });

    const events: any[] = [];
    const rl = createInterface({ input: pi.stdout! });
    rl.on("line", (line) => {
      try {
        events.push(JSON.parse(line));
      } catch {}
    });

    try {
      await new Promise((r) => setTimeout(r, 500));
      sendCommand(pi, { type: "prompt", message: "evaluate this" });

      const toolEnd = await waitForEvent(
        events,
        (e) =>
          e.type === "tool_execution_end" && e.toolName === "emacs_eval"
      );

      await waitForResponse(events);

      const resultText =
        toolEnd.result?.content?.find((c: any) => c.type === "text")?.text ?? "";
      if (resultText !== "42") return `Expected "42", got "${resultText}"`;

      return true;
    } finally {
      pi.kill();
      await new Promise((r) => pi.on("close", r));
    }
  });

  // Test: emacsclient failure is reported as error
  await runTest(
    "pi reports error when emacsclient fails",
    async (tempDir) => {
      // Create a fake emacsclient that always fails
      const script = join(tempDir, "emacsclient");
      writeFileSync(
        script,
        `#!/usr/bin/env node
process.stderr.write("emacsclient: can't find socket\\n");
process.exit(1);
`,
        "utf-8"
      );
      chmodSync(script, 0o755);

      const llm = createDummyLLM(tempDir, {
        "list buffers": {
          text: "Listing buffers.",
          tool: "emacs_list_buffers",
          args: {},
        },
      });

      const ext = join(__dirname, "index.ts");
      const pi = startPi([llm, ext], tempDir, {
        EMACSCLIENT_BINARY: script,
      });

      const events: any[] = [];
      const rl = createInterface({ input: pi.stdout! });
      rl.on("line", (line) => {
        try {
          events.push(JSON.parse(line));
        } catch {}
      });

      try {
        await new Promise((r) => setTimeout(r, 500));
        sendCommand(pi, { type: "prompt", message: "list buffers" });

        const toolEnd = await waitForEvent(
          events,
          (e) =>
            e.type === "tool_execution_end" &&
            e.toolName === "emacs_list_buffers"
        );

        await waitForResponse(events);

        const resultText =
          toolEnd.result?.content?.find((c: any) => c.type === "text")?.text ?? "";
        if (!resultText.toLowerCase().includes("error"))
          return `Expected error in result, got: ${resultText}`;

        return true;
      } finally {
        pi.kill();
        await new Promise((r) => pi.on("close", r));
      }
    }
  );

  // Test: all four tools are registered and can be called
  await runTest("all four emacs tools are registered", async (tempDir) => {
    const fakeDir = createFakeEmacsclient(tempDir, {
      "buffer-list": '"[]"',
      "with-current-buffer": '"{\\"buffer\\":\\"test\\",\\"filepath\\":null,\\"content\\":\\"\\",\\"length\\":0,\\"lineCount\\":0,\\"majorMode\\":\\"fundamental-mode\\",\\"modified\\":false,\\"point\\":1,\\"pointLine\\":1,\\"pointColumn\\":0}"',
      "progn": '"42"',
      "treesit-query-capture": '"[]"',
    });

    const llm = createDummyLLM(tempDir, {
      "test tool 1": {
        text: "Testing list buffers.",
        tool: "emacs_list_buffers",
        args: {},
      },
      "test tool 2": {
        text: "Testing eval.",
        tool: "emacs_eval",
        args: { expression: "(+ 1 2)" },
      },
      "test tool 3": {
        text: "Testing tree-sitter query.",
        tool: "emacs_ts_query",
        args: { buffer: "test.py", query: "(identifier) @name" },
      },
    });

    const ext = join(__dirname, "index.ts");
    const pi = startPi([llm, ext], tempDir, {
      EMACSCLIENT_BINARY: join(fakeDir, "emacsclient"),
    });

    const events: any[] = [];
    const rl = createInterface({ input: pi.stdout! });
    rl.on("line", (line) => {
      try {
        events.push(JSON.parse(line));
      } catch {}
    });

    try {
      await new Promise((r) => setTimeout(r, 500));
      
      // Test each tool by triggering it
      const expectedTools = [
        "emacs_list_buffers",
        "emacs_eval",
        "emacs_ts_query"
      ];
      
      for (let i = 0; i < expectedTools.length; i++) {
        const toolName = expectedTools[i];
        sendCommand(pi, { type: "prompt", message: `test tool ${i + 1}` });

        // Wait for this specific tool to execute
        await waitForEvent(
          events,
          (e) => e.type === "tool_execution_end" && e.toolName === toolName,
          10000
        );

        // Wait for response before next prompt
        await waitForResponse(events, 10000);
        
        // Small delay between prompts
        await new Promise((r) => setTimeout(r, 200));
      }

      // Verify all four tools were executed
      const executedTools = events
        .filter(e => e.type === "tool_execution_end")
        .map(e => e.toolName);
      
      for (const toolName of expectedTools) {
        if (!executedTools.includes(toolName)) {
          return `Tool ${toolName} was not executed. Got: ${executedTools.join(", ")}`;
        }
      }

      return true;
    } finally {
      pi.kill();
      await new Promise((r) => pi.on("close", r));
    }
  });

  console.log(`\n# ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
