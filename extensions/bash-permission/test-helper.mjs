#!/usr/bin/env node
/**
 * Test helper for bash-permission extension
 * Tests the core logic without requiring full pi runtime
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Test config utilities
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
    // Check exact deny first
    if (this.config.deniedExact.includes(command)) {
      return "denied";
    }
    // Then exact allow
    if (this.config.allowedExact.includes(command)) {
      return "allowed";
    }
    // Then prefix deny
    for (const prefix of this.config.deniedPrefixes) {
      if (command.startsWith(prefix)) {
        return "denied";
      }
    }
    // Then prefix allow
    for (const prefix of this.config.allowedPrefixes) {
      if (command.startsWith(prefix)) {
        return "allowed";
      }
    }
    return "unknown";
  }
}

// Test functions
const tests = {
  "test-config-empty": () => {
    const config = new TestConfig();
    if (config.config.allowedExact.length !== 0) {
      throw new Error("Expected empty allowedExact");
    }
    if (config.config.confirmTimeout !== 30000) {
      throw new Error("Expected default timeout 30000");
    }
  },

  "test-config-populated": () => {
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
  },

  "test-config-save": () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bash-perm-test-"));
    const configPath = path.join(tmpDir, "test-config.json");
    
    const testData = {
      allowedExact: ["git status"],
      deniedPrefixes: ["sudo "],
    };
    
    fs.writeFileSync(configPath, JSON.stringify(testData, null, 2));
    const loaded = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    
    if (loaded.allowedExact[0] !== "git status") {
      throw new Error("Config save/load failed");
    }
    
    fs.rmSync(tmpDir, { recursive: true });
  },

  "test-match-exact-allow": () => {
    const config = new TestConfig();
    config.loadFrom({ allowedExact: ["ls -la", "pwd"] });
    
    const result = config.checkCommand("ls -la");
    if (result !== "allowed") {
      throw new Error(`Expected 'allowed', got '${result}'`);
    }
  },

  "test-match-exact-deny": () => {
    const config = new TestConfig();
    config.loadFrom({ deniedExact: ["rm -rf /"] });
    
    const result = config.checkCommand("rm -rf /");
    if (result !== "denied") {
      throw new Error(`Expected 'denied', got '${result}'`);
    }
  },

  "test-match-prefix-allow": () => {
    const config = new TestConfig();
    config.loadFrom({ allowedPrefixes: ["git "] });
    
    const result1 = config.checkCommand("git status");
    const result2 = config.checkCommand("git log --oneline");
    
    if (result1 !== "allowed") {
      throw new Error(`Expected 'allowed' for 'git status', got '${result1}'`);
    }
    if (result2 !== "allowed") {
      throw new Error(`Expected 'allowed' for 'git log', got '${result2}'`);
    }
  },

  "test-match-prefix-deny": () => {
    const config = new TestConfig();
    config.loadFrom({ deniedPrefixes: ["sudo rm"] });
    
    const result = config.checkCommand("sudo rm -rf /home");
    if (result !== "denied") {
      throw new Error(`Expected 'denied', got '${result}'`);
    }
  },

  "test-match-unknown": () => {
    const config = new TestConfig();
    config.loadFrom({ allowedExact: ["ls"] });
    
    const result = config.checkCommand("echo hello");
    if (result !== "unknown") {
      throw new Error(`Expected 'unknown', got '${result}'`);
    }
  },

  "test-priority-exact-deny": () => {
    const config = new TestConfig();
    config.loadFrom({
      allowedExact: ["rm test.txt"],
      deniedExact: ["rm test.txt"],  // Both present - deny should win
    });
    
    const result = config.checkCommand("rm test.txt");
    if (result !== "denied") {
      throw new Error(`Expected 'denied' (exact deny priority), got '${result}'`);
    }
  },

  "test-priority-exact-allow": () => {
    const config = new TestConfig();
    config.loadFrom({
      allowedExact: ["git push"],
      deniedPrefixes: ["git "],  // Prefix deny, but exact allow should win
    });
    
    const result = config.checkCommand("git push");
    if (result !== "allowed") {
      throw new Error(`Expected 'allowed' (exact allow priority), got '${result}'`);
    }
  },

  "test-edge-multiline": () => {
    const config = new TestConfig();
    config.loadFrom({
      allowedPrefixes: ["echo "],
    });
    
    const multilineCmd = "echo 'line1\nline2\nline3'";
    const result = config.checkCommand(multilineCmd);
    
    if (result !== "allowed") {
      throw new Error(`Expected 'allowed' for multiline, got '${result}'`);
    }
  },

  "test-edge-pipe": () => {
    const config = new TestConfig();
    config.loadFrom({
      allowedPrefixes: ["ls "],
    });
    
    const pipedCmd = "ls -la | grep test | wc -l";
    const result = config.checkCommand(pipedCmd);
    
    if (result !== "allowed") {
      throw new Error(`Expected 'allowed' for piped command, got '${result}'`);
    }
  },

  "test-edge-escaped": () => {
    const config = new TestConfig();
    config.loadFrom({
      allowedExact: ["echo \"hello world\""],
    });
    
    const result = config.checkCommand("echo \"hello world\"");
    if (result !== "allowed") {
      throw new Error(`Expected 'allowed' for escaped chars, got '${result}'`);
    }
  },

  "test-edge-empty-prefix": () => {
    const config = new TestConfig();
    config.loadFrom({
      allowedPrefixes: [""],  // Empty prefix would match everything
    });
    
    // Empty prefix should still work (matches everything)
    const result = config.checkCommand("anything");
    if (result !== "allowed") {
      throw new Error(`Expected 'allowed' for empty prefix, got '${result}'`);
    }
  },
};

// Run test
const testName = process.argv[2];
if (!testName || !tests[testName]) {
  console.error(`Unknown test: ${testName}`);
  console.error(`Available tests: ${Object.keys(tests).join(", ")}`);
  process.exit(1);
}

try {
  tests[testName]();
  process.exit(0);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
