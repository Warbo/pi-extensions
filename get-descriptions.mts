#!/usr/bin/env tsx
/**
 * Extracts tool descriptions from pi extensions and built-in tools,
 * writing one file per tool into the output directory.
 *
 * Usage: get-descriptions.ts <extensions-dir> <output-dir>
 */
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  readTool,
  bashTool,
  editTool,
  writeTool,
} from "@mariozechner/pi-coding-agent";
import { readdir } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const [, , extensionsDir, outputDir] = process.argv;
if (!extensionsDir || !outputDir) {
  console.error("Usage: get-descriptions.mts <extensions-dir> <output-dir>");
  process.exit(1);
}

// Find all extension index.ts files
const entries = await readdir(extensionsDir, { withFileTypes: true });
const extensionPaths = entries
  .filter((e) => e.isDirectory())
  .map((e) => join(extensionsDir, e.name, "index.ts"));

console.error(`Found extensions: ${extensionPaths.join(", ")}`);

const loader = new DefaultResourceLoader({ additionalExtensionPaths: extensionPaths });
await loader.reload();

const { extensionsResult } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
  resourceLoader: loader,
});

// Built-in tools
const builtins = [readTool, bashTool, editTool, writeTool];
for (const tool of builtins) {
  console.error(`Built-in tool: ${tool.name} — ${tool.description?.slice(0, 60)}`);
  writeFileSync(join(outputDir, tool.name), tool.description ?? "");
}

// Extension-registered tools
const extTools = extensionsResult.runtime.getAllTools();
console.error(`Extension tools: ${extTools.map((t) => t.name).join(", ")}`);
for (const tool of extTools) {
  writeFileSync(join(outputDir, tool.name), tool.description ?? "");
}

console.error(`Done. Wrote ${builtins.length + extTools.length} tool descriptions.`);
