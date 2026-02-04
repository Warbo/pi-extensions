#!/usr/bin/env node
/**
 * Unit tests for editor script generation
 */

import { readFileSync, writeFileSync, unlinkSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import { createIssueEditorScript, createCommentEditorScript } from "./editor.mjs";

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

// Test: Issue editor script generation
runTest("Issue editor script contains shebang", () => {
	const script = createIssueEditorScript("/tmp/subject", "/tmp/body");
	if (!script.startsWith("#!/bin/sh")) {
		return "Script missing proper shebang";
	}
	return true;
});

runTest("Issue editor script references subject file", () => {
	const script = createIssueEditorScript("/tmp/subject.txt", "/tmp/body.txt");
	if (!script.includes("/tmp/subject.txt")) {
		return "Script doesn't reference subject file";
	}
	return true;
});

runTest("Issue editor script references body file", () => {
	const script = createIssueEditorScript("/tmp/subject.txt", "/tmp/body.txt");
	if (!script.includes("/tmp/body.txt")) {
		return "Script doesn't reference body file";
	}
	return true;
});

// Test: Comment editor script generation
runTest("Comment editor script contains shebang", () => {
	const script = createCommentEditorScript("/tmp/body");
	if (!script.startsWith("#!/bin/sh")) {
		return "Script missing proper shebang";
	}
	return true;
});

runTest("Comment editor script references body file", () => {
	const script = createCommentEditorScript("/tmp/body.txt");
	if (!script.includes("/tmp/body.txt")) {
		return "Script doesn't reference body file";
	}
	return true;
});

// Test: Issue editor script execution
runTest("Issue editor replaces subject line", () => {
	const testDir = mkdtempSync(join(tmpdir(), "artemis-test-"));
	
	// Create test files
	const subjectFile = join(testDir, "subject.txt");
	const bodyFile = join(testDir, "body.txt");
	const templateFile = join(testDir, "template.txt");
	const scriptFile = join(testDir, "editor.sh");
	
	writeFileSync(subjectFile, "My Test Subject");
	writeFileSync(bodyFile, "My test body");
	writeFileSync(templateFile, `From: Test User
Date: Wed, 04 Feb 2026 10:00:00 +0000
State: new
Subject: brief description

Detailed description.`);
	
	const script = createIssueEditorScript(subjectFile, bodyFile);
	writeFileSync(scriptFile, script, { mode: 0o755 });
	
	// Run the script
	const result = spawnSync(scriptFile, [templateFile]);
	
	// Check output
	const output = readFileSync(templateFile, "utf-8");
	
	// Cleanup
	unlinkSync(subjectFile);
	unlinkSync(bodyFile);
	unlinkSync(templateFile);
	unlinkSync(scriptFile);
	
	if (!output.includes("Subject: My Test Subject")) {
		return `Subject not replaced. Output:\n${output}`;
	}
	
	return true;
});

runTest("Issue editor replaces body", () => {
	const testDir = mkdtempSync(join(tmpdir(), "artemis-test-"));
	
	// Create test files
	const subjectFile = join(testDir, "subject.txt");
	const bodyFile = join(testDir, "body.txt");
	const templateFile = join(testDir, "template.txt");
	const scriptFile = join(testDir, "editor.sh");
	
	writeFileSync(subjectFile, "Test Subject");
	writeFileSync(bodyFile, "Line 1 of body\nLine 2 of body");
	writeFileSync(templateFile, `From: Test User
Date: Wed, 04 Feb 2026 10:00:00 +0000
State: new
Subject: brief description

Detailed description.`);
	
	const script = createIssueEditorScript(subjectFile, bodyFile);
	writeFileSync(scriptFile, script, { mode: 0o755 });
	
	// Run the script
	const result = spawnSync(scriptFile, [templateFile]);
	
	// Check output
	const output = readFileSync(templateFile, "utf-8");
	
	// Cleanup
	unlinkSync(subjectFile);
	unlinkSync(bodyFile);
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

runTest("Issue editor preserves other lines", () => {
	const testDir = mkdtempSync(join(tmpdir(), "artemis-test-"));
	
	// Create test files
	const subjectFile = join(testDir, "subject.txt");
	const bodyFile = join(testDir, "body.txt");
	const templateFile = join(testDir, "template.txt");
	const scriptFile = join(testDir, "editor.sh");
	
	writeFileSync(subjectFile, "Test");
	writeFileSync(bodyFile, "Body");
	writeFileSync(templateFile, `From: Test User
Date: Wed, 04 Feb 2026 10:00:00 +0000
State: new
Subject: brief description

Detailed description.`);
	
	const script = createIssueEditorScript(subjectFile, bodyFile);
	writeFileSync(scriptFile, script, { mode: 0o755 });
	
	// Run the script
	spawnSync(scriptFile, [templateFile]);
	
	// Check output
	const output = readFileSync(templateFile, "utf-8");
	
	// Cleanup
	unlinkSync(subjectFile);
	unlinkSync(bodyFile);
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

// Test: Comment editor script execution
runTest("Comment editor replaces body", () => {
	const testDir = mkdtempSync(join(tmpdir(), "artemis-test-"));
	
	// Create test files
	const bodyFile = join(testDir, "body.txt");
	const templateFile = join(testDir, "template.txt");
	const scriptFile = join(testDir, "editor.sh");
	
	writeFileSync(bodyFile, "This is my comment\nWith multiple lines");
	writeFileSync(templateFile, `From: Test User
Date: Wed, 04 Feb 2026 10:00:00 +0000
Subject: Re: Original Subject

Detailed description.`);
	
	const script = createCommentEditorScript(bodyFile);
	writeFileSync(scriptFile, script, { mode: 0o755 });
	
	// Run the script
	spawnSync(scriptFile, [templateFile]);
	
	// Check output
	const output = readFileSync(templateFile, "utf-8");
	
	// Cleanup
	unlinkSync(bodyFile);
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

runTest("Comment editor preserves headers", () => {
	const testDir = mkdtempSync(join(tmpdir(), "artemis-test-"));
	
	// Create test files
	const bodyFile = join(testDir, "body.txt");
	const templateFile = join(testDir, "template.txt");
	const scriptFile = join(testDir, "editor.sh");
	
	writeFileSync(bodyFile, "Comment text");
	writeFileSync(templateFile, `From: Test User
Date: Wed, 04 Feb 2026 10:00:00 +0000
Subject: Re: Original Subject

Detailed description.`);
	
	const script = createCommentEditorScript(bodyFile);
	writeFileSync(scriptFile, script, { mode: 0o755 });
	
	// Run the script
	spawnSync(scriptFile, [templateFile]);
	
	// Check output
	const output = readFileSync(templateFile, "utf-8");
	
	// Cleanup
	unlinkSync(bodyFile);
	unlinkSync(templateFile);
	unlinkSync(scriptFile);
	
	if (!output.includes("From: Test User")) {
		return "From line not preserved";
	}
	
	if (!output.includes("Subject: Re: Original Subject")) {
		return "Subject line not preserved (for comments, subject should NOT be replaced)";
	}
	
	return true;
});

process.exit(failCount > 0 ? 1 : 0);
