/**
 * ReAct format adapter for pi.
 *
 * Many local models (especially LangChain-tuned ones) emit a "ReAct" text
 * protocol instead of proper OpenAI-style tool_calls:
 *
 *   THOUGHT: I need to list the files…
 *   {"name": "bash", "arguments": {"command": "ls -la"}}
 *
 * Pi's built-in openai-completions handler only understands native
 * tool_calls, so the thoughts get dumped verbatim and the JSON tool
 * invocations are silently ignored.
 *
 * This extension registers a custom API type called "react" that:
 *   1. Sends requests to the model's OpenAI-compatible chat/completions endpoint.
 *   2. Parses THOUGHT: blocks → pi `thinking` content blocks.
 *   3. Parses JSON tool-call objects → pi `toolCall` content blocks.
 *   4. Passes plain text through as normal `text` content blocks.
 *
 * Setup:
 *   1. Put this in ~/.pi/agent/extensions/ollama-react/index.ts
 *      (or load with  pi -e ./extensions/ollama-react/index.ts)
 *
 *   2. Configure your model in ~/.pi/agent/models.json using "api": "react":
 *
 *      {
 *        "providers": {
 *          "ollama": {
 *            "baseUrl": "http://localhost:11434/v1",
 *            "api": "react",
 *            "apiKey": "ollama",
 *            "models": [
 *              { "id": "qwen2.5:14b" },
 *              { "id": "my-react-model:latest" }
 *            ]
 *          }
 *        }
 *      }
 *
 *   3. Select the model via /model in pi — it will use ReAct parsing
 *      automatically because of the "react" api type.
 *
 * Any provider (ollama, vLLM, LM Studio, a remote endpoint) works as long
 * as it exposes an OpenAI-compatible /chat/completions endpoint and the
 * model outputs ReAct-formatted text.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
  calculateCost,
  createAssistantMessageEventStream,
} from "@mariozechner/pi-ai";

// ---------------------------------------------------------------------------
// ReAct text parser
// ---------------------------------------------------------------------------

interface ParsedBlock {
  type: "thought" | "tool_call" | "text";
  content: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
}

/**
 * Parse a completed response into an ordered list of blocks.
 *
 * Recognises:
 *   THOUGHT: … (everything until next block)
 *   {"name": "…", "arguments": {…}}   (tool call, possibly multi-line)
 *   Anything else → plain text
 */
function parseReActResponse(text: string): ParsedBlock[] {
  const blocks: ParsedBlock[] = [];
  const lines = text.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // --- THOUGHT block -------------------------------------------------
    if (/^\s*THOUGHT:\s*/i.test(line)) {
      const thoughtLines: string[] = [line.replace(/^\s*THOUGHT:\s*/i, "")];
      i++;
      while (i < lines.length) {
        if (/^\s*THOUGHT:\s*/i.test(lines[i])) break;
        if (/^\s*\{/.test(lines[i]) && looksLikeToolCall(lines, i)) break;
        thoughtLines.push(lines[i]);
        i++;
      }
      const content = thoughtLines.join("\n").trim();
      if (content) {
        blocks.push({ type: "thought", content });
      }
      continue;
    }

    // --- JSON tool call ------------------------------------------------
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
        // Not valid JSON – fall through to plain text
      }
      blocks.push({ type: "text", content: json });
      continue;
    }

    // --- Plain text ----------------------------------------------------
    const textLines: string[] = [line];
    i++;
    while (i < lines.length) {
      if (/^\s*THOUGHT:\s*/i.test(lines[i])) break;
      if (/^\s*\{/.test(lines[i]) && looksLikeToolCall(lines, i)) break;
      textLines.push(lines[i]);
      i++;
    }
    const content = textLines.join("\n").trim();
    if (content) {
      blocks.push({ type: "text", content });
    }
  }

  return blocks;
}

/** Quick heuristic: does the JSON starting at `start` look like {"name":…}? */
function looksLikeToolCall(lines: string[], start: number): boolean {
  let peek = "";
  for (let j = start; j < lines.length && peek.length < 500; j++) {
    peek += lines[j] + "\n";
  }
  return /"\s*name\s*"\s*:/.test(peek);
}

/** Extract a brace-balanced JSON object starting at `start`. */
function extractJsonObject(
  lines: string[],
  start: number
): { json: string; endIndex: number } {
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

// ---------------------------------------------------------------------------
// Context → OpenAI messages conversion
// ---------------------------------------------------------------------------

function contextToOpenAIMessages(
  context: Context
): Array<{ role: string; content: string }> {
  const messages: Array<{ role: string; content: string }> = [];

  if (context.systemPrompt) {
    messages.push({ role: "system", content: context.systemPrompt });
  }

  for (const msg of context.messages) {
    if (msg.role === "user") {
      const text = msg.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("\n");
      if (text) messages.push({ role: "user", content: text });
    } else if (msg.role === "assistant") {
      const parts: string[] = [];
      for (const c of msg.content) {
        if (c.type === "text") parts.push(c.text);
        if (c.type === "thinking") parts.push(`THOUGHT: ${c.thinking}`);
        if (c.type === "toolCall") {
          parts.push(
            JSON.stringify({ name: c.name, arguments: c.arguments })
          );
        }
      }
      if (parts.length)
        messages.push({ role: "assistant", content: parts.join("\n") });
    } else if (msg.role === "toolResult") {
      // ReAct models don't use the OpenAI tool role, so feed results
      // back as user messages.
      const text = msg.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("\n");
      messages.push({
        role: "user",
        content: `[Tool result for "${msg.toolName}"]\n${text}`,
      });
    }
  }

  return messages;
}

// ---------------------------------------------------------------------------
// Custom stream implementation
// ---------------------------------------------------------------------------

let toolCallCounter = 0;

function streamReAct(
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
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    try {
      stream.push({ type: "start", partial: output });

      const messages = contextToOpenAIMessages(context);

      // Build request URL from the model's baseUrl (set by models.json)
      const baseUrl = (model.baseUrl ?? "").replace(/\/+$/, "");
      const url = `${baseUrl}/chat/completions`;

      // Build headers — use model.headers if set, plus auth
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...(model.headers ?? {}),
      };

      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: model.id,
          messages,
          max_tokens: model.maxTokens,
          stream: false,
        }),
        signal: options?.signal,
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(
          `${model.provider} returned ${response.status}: ${body.slice(0, 500)}`
        );
      }

      const json = (await response.json()) as any;
      const fullText: string = json.choices?.[0]?.message?.content ?? "";

      // Update usage if the endpoint provides it
      if (json.usage) {
        output.usage.input = json.usage.prompt_tokens ?? 0;
        output.usage.output = json.usage.completion_tokens ?? 0;
        output.usage.totalTokens = output.usage.input + output.usage.output;
        calculateCost(model, output.usage);
      }

      // Parse the ReAct response into structured blocks
      const blocks = parseReActResponse(fullText);

      // Emit pi stream events for each block
      for (const block of blocks) {
        const contentIndex = output.content.length;

        switch (block.type) {
          case "thought": {
            output.content.push({ type: "thinking", thinking: block.content });
            stream.push({ type: "thinking_start", contentIndex, partial: output });
            stream.push({ type: "thinking_delta", contentIndex, delta: block.content, partial: output });
            stream.push({ type: "thinking_end", contentIndex, content: block.content, partial: output });
            break;
          }

          case "tool_call": {
            const id = `react-tc-${++toolCallCounter}`;
            output.content.push({
              type: "toolCall",
              id,
              name: block.toolName!,
              arguments: block.toolArgs!,
            });
            stream.push({ type: "toolcall_start", contentIndex, partial: output });
            stream.push({ type: "toolcall_delta", contentIndex, delta: block.content, partial: output });
            stream.push({
              type: "toolcall_end",
              contentIndex,
              toolCall: { type: "toolCall", id, name: block.toolName!, arguments: block.toolArgs! },
              partial: output,
            });
            break;
          }

          case "text": {
            output.content.push({ type: "text", text: block.content });
            stream.push({ type: "text_start", contentIndex, partial: output });
            stream.push({ type: "text_delta", contentIndex, delta: block.content, partial: output });
            stream.push({ type: "text_end", contentIndex, content: block.content, partial: output });
            break;
          }
        }
      }

      const hasToolCalls = blocks.some((b) => b.type === "tool_call");
      output.stopReason = hasToolCalls ? "toolUse" : "stop";

      stream.push({
        type: "done",
        reason: output.stopReason as "stop" | "toolUse",
        message: output,
      });
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

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // We need access to the model registry at stream time to resolve API keys
  // for providers that don't use authHeader. Capture it from the first event.
  let modelRegistry: any = null;

  pi.on("session_start", async (_event, ctx) => {
    modelRegistry = ctx.modelRegistry;
  });

  // Create a wrapper that injects the API key from the registry when the
  // model's headers don't already include an Authorization header.
  const streamWithAuth = (
    model: Model<any>,
    context: Context,
    options?: SimpleStreamOptions
  ): AssistantMessageEventStream => {
    if (modelRegistry && !model.headers?.["Authorization"]) {
      // Resolve API key and inject it. getApiKey is async, so we handle
      // it inside the stream's async IIFE by wrapping the model.
      const origStream = streamReAct;
      const stream = createAssistantMessageEventStream();

      (async () => {
        try {
          const apiKey = await modelRegistry.getApiKey(model);
          const augmentedModel = apiKey
            ? {
                ...model,
                headers: {
                  ...model.headers,
                  Authorization: `Bearer ${apiKey}`,
                },
              }
            : model;

          // Pipe the inner stream to our outer stream
          const inner = origStream(augmentedModel, context, options);
          for await (const event of inner) {
            stream.push(event);
          }
          stream.end();
        } catch (error) {
          const output: AssistantMessage = {
            role: "assistant",
            content: [],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: {
              input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "error",
            errorMessage: error instanceof Error ? error.message : String(error),
            timestamp: Date.now(),
          };
          stream.push({ type: "error", reason: "error", error: output });
          stream.end();
        }
      })();

      return stream;
    }

    return streamReAct(model, context, options);
  };

  // Register the "react" API type with our custom stream function.
  // Any model in models.json that uses "api": "react" will be handled
  // by this parser. No hardcoded URLs, keys, or model lists needed.
  pi.registerProvider("__react_api", {
    api: "react" as any,
    streamSimple: streamWithAuth,
  });
}
