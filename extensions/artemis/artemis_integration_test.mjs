#!/usr/bin/env node
/**
 * Integration tests for git artemis behavior
 * Tests our assumptions about how git artemis works with EDITOR
 */

import { spawn } from "child_process";
import { mkdtempSync, writeFileSync, unlinkSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

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

async function runTest(name, testFn) {
	const testDir = mkdtempSync(join(tmpdir(), "artemis-git-test-"));
	
	try {
		// Initialize git repo
		await execCommand("git", ["init"], testDir);
		await execCommand("git", ["config", "user.name", "Test User"], testDir);
		await execCommand("git", ["config", "user.email", "test@test.com"], testDir);
		
		const result = await testFn(testDir);
		
		if (result === true) {
			testPass(name);
		} else {
			testFail(name, result || "Test returned false");
		}
	} catch (error) {
		testFail(name, error.message);
	} finally {
		rmSync(testDir, { recursive: true, force: true });
	}
}

function execCommand(cmd, args, cwd, env = {}) {
	return new Promise((resolve, reject) => {
		const proc = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: "pipe" });
		
		let stdout = "";
		let stderr = "";
		
		proc.stdout.on("data", (data) => { stdout += data.toString(); });
		proc.stderr.on("data", (data) => { stderr += data.toString(); });
		
		proc.on("close", (code) => {
			if (code === 0) {
				resolve({ stdout, stderr, code });
			} else {
				reject(new Error(`Command failed with code ${code}: ${stderr || stdout}`));
			}
		});
	});
}

// Test: Verify template format for new issue
await runTest("Git artemis new issue template has expected format", async (testDir) => {
	// Create an editor that dumps the template
	const dumpFile = join(testDir, "template-dump.txt");
	const editorScript = join(testDir, "dump-editor.sh");
	
	writeFileSync(editorScript, `#!/bin/sh
cp "$1" "${dumpFile}"
`, { mode: 0o755 });
	
	// Try to create an issue (will fail because we don't modify the template)
	const proc = spawn("git", ["artemis", "add"], {
		cwd: testDir,
		env: { ...process.env, EDITOR: editorScript },
		stdio: "pipe"
	});
	
	await new Promise((resolve) => proc.on("close", resolve));
	
	// Read the dumped template
	let template;
	try {
		template = readFileSync(dumpFile, "utf-8");
	} catch (e) {
		return `Failed to read template dump: ${e.message}`;
	}
	
	// Verify expected fields
	if (!template.includes("From:")) {
		return `Template missing "From:" field. Template:\n${template}`;
	}
	
	if (!template.includes("Date:")) {
		return `Template missing "Date:" field. Template:\n${template}`;
	}
	
	if (!template.includes("State:")) {
		return `Template missing "State:" field. Template:\n${template}`;
	}
	
	if (!template.includes("Subject:")) {
		return `Template missing "Subject:" field. Template:\n${template}`;
	}
	
	if (!template.includes("Detailed description.")) {
		return `Template missing "Detailed description." placeholder. Template:\n${template}`;
	}
	
	return true;
});

// Test: Verify template format for comment
await runTest("Git artemis comment template has expected format", async (testDir) => {
	// First create an issue
	const { stdout } = await execCommand("git", ["artemis", "add", "-m", "Test Issue"], testDir);
	const issueIdMatch = stdout.match(/([a-f0-9]{16})/);
	
	if (!issueIdMatch) {
		return "Failed to create test issue";
	}
	
	const issueId = issueIdMatch[1];
	
	// Create an editor that dumps the template
	const dumpFile = join(testDir, "comment-template-dump.txt");
	const editorScript = join(testDir, "dump-editor.sh");
	
	writeFileSync(editorScript, `#!/bin/sh
cp "$1" "${dumpFile}"
`, { mode: 0o755 });
	
	// Try to add a comment (will fail because we don't modify the template)
	const proc = spawn("git", ["artemis", "add", issueId], {
		cwd: testDir,
		env: { ...process.env, EDITOR: editorScript },
		stdio: "pipe"
	});
	
	await new Promise((resolve) => proc.on("close", resolve));
	
	// Read the dumped template
	let template;
	try {
		template = readFileSync(dumpFile, "utf-8");
	} catch (e) {
		return `Failed to read template dump: ${e.message}`;
	}
	
	// Verify expected fields
	if (!template.includes("From:")) {
		return `Template missing "From:" field. Template:\n${template}`;
	}
	
	if (!template.includes("Date:")) {
		return `Template missing "Date:" field. Template:\n${template}`;
	}
	
	if (!template.includes("Subject:")) {
		return `Template missing "Subject:" field. Template:\n${template}`;
	}
	
	if (!template.includes("Detailed description.")) {
		return `Template missing "Detailed description." placeholder. Template:\n${template}`;
	}
	
	return true;
});

// Test: Issue created with modified template includes body
await runTest("Git artemis creates issue with body text", async (testDir) => {
	// Create files for editor
	const subjectFile = join(testDir, "subject.txt");
	const bodyFile = join(testDir, "body.txt");
	
	writeFileSync(subjectFile, "Integration Test Subject");
	writeFileSync(bodyFile, "This is the body text\nWith multiple lines\nFor testing");
	
	// Create editor that modifies the template
	const editorScript = join(testDir, "modify-editor.sh");
	writeFileSync(editorScript, `#!/bin/sh
{
  while IFS= read -r line || [ -n "\${line}" ]; do
    case "\${line}" in
      Subject:*)
        printf "Subject: "
        cat '${subjectFile}'
        echo ""
        ;;
      "Detailed description.")
        cat '${bodyFile}'
        ;;
      *)
        echo "\${line}"
        ;;
    esac
  done < "$1"
} > "$1.tmp" && mv "$1.tmp" "$1"
`, { mode: 0o755 });
	
	// Create issue
	const { stdout } = await execCommand("git", ["artemis", "add"], testDir, { EDITOR: editorScript });
	
	const issueIdMatch = stdout.match(/([a-f0-9]{16})/);
	if (!issueIdMatch) {
		return `Failed to extract issue ID from output: ${stdout}`;
	}
	
	const issueId = issueIdMatch[1];
	
	// Show the issue
	const { stdout: showOutput } = await execCommand("git", ["artemis", "show", issueId], testDir);
	
	// Verify body text is present
	if (!showOutput.includes("This is the body text")) {
		return `Issue body not found. Output:\n${showOutput}`;
	}
	
	if (!showOutput.includes("With multiple lines")) {
		return `Multiline body not fully stored. Output:\n${showOutput}`;
	}
	
	return true;
});

// Test: Comment created with modified template includes body
await runTest("Git artemis creates comment with body text", async (testDir) => {
	// First create an issue
	const { stdout: addOutput } = await execCommand("git", ["artemis", "add", "-m", "Test Issue"], testDir);
	const issueIdMatch = addOutput.match(/([a-f0-9]{16})/);
	
	if (!issueIdMatch) {
		return "Failed to create test issue";
	}
	
	const issueId = issueIdMatch[1];
	
	// Create files for editor
	const bodyFile = join(testDir, "comment-body.txt");
	writeFileSync(bodyFile, "This is my comment\nWith some details\nAnd more info");
	
	// Create editor that modifies the template
	const editorScript = join(testDir, "comment-editor.sh");
	writeFileSync(editorScript, `#!/bin/sh
{
  while IFS= read -r line || [ -n "\${line}" ]; do
    if [ "\${line}" = "Detailed description." ]; then
      cat '${bodyFile}'
    else
      echo "\${line}"
    fi
  done < "$1"
} > "$1.tmp" && mv "$1.tmp" "$1"
`, { mode: 0o755 });
	
	// Add comment
	await execCommand("git", ["artemis", "add", issueId], testDir, { EDITOR: editorScript });
	
	// Show the issue to see comments
	const { stdout: showOutput } = await execCommand("git", ["artemis", "show", issueId], testDir);
	
	// Check for comment indicator
	if (!showOutput.includes("Comments:")) {
		return `No comments found. Output:\n${showOutput}`;
	}
	
	// Show comment 1 (first comment)
	const { stdout: commentOutput } = await execCommand("git", ["artemis", "show", issueId, "1"], testDir);
	
	// Verify comment body text is present
	if (!commentOutput.includes("This is my comment")) {
		return `Comment body not found. Output:\n${commentOutput}`;
	}
	
	if (!commentOutput.includes("With some details")) {
		return `Multiline comment not fully stored. Output:\n${commentOutput}`;
	}
	
	return true;
});

process.exit(failCount > 0 ? 1 : 0);
