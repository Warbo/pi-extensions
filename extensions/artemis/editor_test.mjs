#!/usr/bin/env node
/**
 * Unit tests for editor script generation
 */

import { readFileSync, writeFileSync, unlinkSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import { createEditorScript } from "./editor.mjs";

let failCount = 0;

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

function runTest(name, testFn) {
	try {
		const result = testFn();
		if (result === true) {
			testPass(name);
		} else {
			testFail(name, result || "Test returned false");
		}
	} catch (error) {
		testFail(name, error.message);
	}
}

// Test: Editor script generation
runTest("Editor script contains shebang", () => {
	const script = createEditorScript();
	if (!script.startsWith("#!/bin/sh")) {
		return "Script missing proper shebang";
	}
	return true;
});

runTest("Editor script uses SUBJECT env var", () => {
	const script = createEditorScript();
	if (!script.includes("$SUBJECT") && !script.includes("${SUBJECT}")) {
		return "Script doesn't use SUBJECT environment variable";
	}
	return true;
});

runTest("Editor script uses BODY env var", () => {
	const script = createEditorScript();
	if (!script.includes("$BODY") && !script.includes("${BODY}")) {
		return "Script doesn't use BODY environment variable";
	}
	return true;
});

// Test: Editor script execution for issues
runTest("Editor replaces subject line", () => {
	const testDir = mkdtempSync(join(tmpdir(), "artemis-test-"));
	
	// Create test files
	const templateFile = join(testDir, "template.txt");
	const scriptFile = join(testDir, "editor.sh");
	
	writeFileSync(templateFile, `From: Test User
Date: Wed, 04 Feb 2026 10:00:00 +0000
State: new
Subject: brief description

Detailed description.`);
	
	const script = createEditorScript();
	writeFileSync(scriptFile, script, { mode: 0o755 });
	
	// Run the script with SUBJECT env var
	const result = spawnSync(scriptFile, [templateFile], {
		env: { ...process.env, SUBJECT: "My Test Subject", BODY: "My test body" }
	});
	
	// Check output
	const output = readFileSync(templateFile, "utf-8");
	
	// Cleanup
	unlinkSync(templateFile);
	unlinkSync(scriptFile);
	
	if (!output.includes("Subject: My Test Subject")) {
		return `Subject not replaced. Output:\n${output}`;
	}
	
	return true;
});

runTest("Editor replaces body", () => {
	const testDir = mkdtempSync(join(tmpdir(), "artemis-test-"));
	
	// Create test files
	const templateFile = join(testDir, "template.txt");
	const scriptFile = join(testDir, "editor.sh");
	
	writeFileSync(templateFile, `From: Test User
Date: Wed, 04 Feb 2026 10:00:00 +0000
State: new
Subject: brief description

Detailed description.`);
	
	const script = createEditorScript();
	writeFileSync(scriptFile, script, { mode: 0o755 });
	
	// Run the script
	spawnSync(scriptFile, [templateFile], {
		env: { ...process.env, SUBJECT: "Test Subject", BODY: "Line 1 of body\nLine 2 of body" }
	});
	
	// Check output
	const output = readFileSync(templateFile, "utf-8");
	
	// Cleanup
	unlinkSync(templateFile);
	unlinkSync(scriptFile);
	
	if (!output.includes("Line 1 of body")) {
		return `Body not replaced. Output:\n${output}`;
	}
	
	if (!output.includes("Line 2 of body")) {
		return `Multiline body not fully replaced. Output:\n${output}`;
	}
	
	if (output.includes("Detailed description.")) {
		return `"Detailed description." not removed. Output:\n${output}`;
	}
	
	return true;
});

runTest("Editor preserves other lines", () => {
	const testDir = mkdtempSync(join(tmpdir(), "artemis-test-"));
	
	// Create test files
	const templateFile = join(testDir, "template.txt");
	const scriptFile = join(testDir, "editor.sh");
	
	writeFileSync(templateFile, `From: Test User
Date: Wed, 04 Feb 2026 10:00:00 +0000
State: new
Subject: brief description

Detailed description.`);
	
	const script = createEditorScript();
	writeFileSync(scriptFile, script, { mode: 0o755 });
	
	// Run the script
	spawnSync(scriptFile, [templateFile], {
		env: { ...process.env, SUBJECT: "Test", BODY: "Body" }
	});
	
	// Check output
	const output = readFileSync(templateFile, "utf-8");
	
	// Cleanup
	unlinkSync(templateFile);
	unlinkSync(scriptFile);
	
	if (!output.includes("From: Test User")) {
		return "From line not preserved";
	}
	
	if (!output.includes("Date: Wed, 04 Feb 2026 10:00:00 +0000")) {
		return "Date line not preserved";
	}
	
	if (!output.includes("State: new")) {
		return "State line not preserved";
	}
	
	return true;
});

// Test: Editor script execution for comments
runTest("Editor works for comments (with Re: subject)", () => {
	const testDir = mkdtempSync(join(tmpdir(), "artemis-test-"));
	
	// Create test files (comment template has Subject: Re: ...)
	const templateFile = join(testDir, "template.txt");
	const scriptFile = join(testDir, "editor.sh");
	
	writeFileSync(templateFile, `From: Test User
Date: Wed, 04 Feb 2026 10:00:00 +0000
Subject: Re: Original Subject

Detailed description.`);
	
	const script = createEditorScript();
	writeFileSync(scriptFile, script, { mode: 0o755 });
	
	// Run the script
	spawnSync(scriptFile, [templateFile], {
		env: { ...process.env, SUBJECT: "Re: comment", BODY: "This is my comment\nWith multiple lines" }
	});
	
	// Check output
	const output = readFileSync(templateFile, "utf-8");
	
	// Cleanup
	unlinkSync(templateFile);
	unlinkSync(scriptFile);
	
	if (!output.includes("This is my comment")) {
		return `Comment body not replaced. Output:\n${output}`;
	}
	
	if (!output.includes("With multiple lines")) {
		return `Multiline comment not fully replaced. Output:\n${output}`;
	}
	
	if (output.includes("Detailed description.")) {
		return `"Detailed description." not removed. Output:\n${output}`;
	}
	
	return true;
});

process.exit(failCount > 0 ? 1 : 0);
