/**
 * Dummy LLM Provider for Testing
 * 
 * Returns canned responses without making network calls.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
	createAssistantMessageEventStream,
} from "@mariozechner/pi-ai";

// Canned responses for testing
const cannedResponses: Record<string, { text: string; tools?: Array<{ name: string; command: string }> }> = {
	default: {
		text: "I'll help you test the bash-permission extension.",
	},
	"list files": {
		text: "I'll list the files for you.",
		tools: [{ name: "bash", command: "ls -la" }],
	},
	"check git status": {
		text: "Let me check the git status.",
		tools: [{ name: "bash", command: "git status" }],
	},
	"remove something": {
		text: "I'll remove that file.",
		tools: [{ name: "bash", command: "rm -rf test.txt" }],
	},
	"multiple commands": {
		text: "I'll run multiple commands.",
		tools: [
			{ name: "bash", command: "echo hello" },
			{ name: "bash", command: "pwd" },
			{ name: "bash", command: "date" },
		],
	},
};

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
			// Check for abort signal
			if (options?.signal?.aborted) {
				throw new Error("Aborted");
			}

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

			// Get the last user message
			const lastUserMsg = context.messages.findLast((m) => m.role === "user");
			const userText =
				typeof lastUserMsg?.content === "string"
					? lastUserMsg.content
					: lastUserMsg?.content?.find((c) => c.type === "text")?.text ?? "";

			// Find matching canned response
			let response = cannedResponses.default;
			for (const [key, value] of Object.entries(cannedResponses)) {
				if (userText.toLowerCase().includes(key.toLowerCase())) {
					response = value;
					break;
				}
			}

			// Start streaming
			stream.push({ type: "start", partial: output });

			// Add text content
			const textContent = { type: "text" as const, text: "" };
			output.content.push(textContent);
			stream.push({ type: "text_start", contentIndex: 0, partial: output });

			// Stream text in chunks
			for (let i = 0; i < response.text.length; i += 10) {
				if (options?.signal?.aborted) throw new Error("Aborted");
				const chunk = response.text.slice(i, i + 10);
				textContent.text += chunk;
				stream.push({ type: "text_delta", contentIndex: 0, delta: chunk, partial: output });
				// Small delay to simulate streaming
				await new Promise((resolve) => setTimeout(resolve, 10));
			}

			stream.push({ type: "text_end", contentIndex: 0, content: textContent.text, partial: output });

			// Add tool calls if any
			if (response.tools) {
				output.stopReason = "toolUse";
				for (let i = 0; i < response.tools.length; i++) {
					const tool = response.tools[i];
					const contentIndex = output.content.length;
					const toolCall = {
						type: "toolCall" as const,
						id: `call_${Date.now()}_${i}`,
						name: tool.name,
						arguments: { command: tool.command },
					};

					output.content.push(toolCall);
					stream.push({ type: "toolcall_start", contentIndex, partial: output });
					stream.push({
						type: "toolcall_end",
						contentIndex,
						toolCall,
						partial: output,
					});
				}
			}

			// Done
			stream.push({
				type: "done",
				reason: output.stopReason as "stop" | "length" | "toolUse",
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
