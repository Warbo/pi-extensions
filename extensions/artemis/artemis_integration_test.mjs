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
	// Create editor that modifies the template using SUBJECT/BODY env vars
	const editorScript = join(testDir, "modify-editor.sh");
	writeFileSync(editorScript, `#!/bin/sh
set -e
temp="$1.tmp"
{
  found_subject=0
  while IFS= read -r line || [ -n "\${line}" ]; do
    if [ "\${found_subject}" -eq 0 ]; then
      case "\${line}" in
        Subject:*)
          echo "Subject: \${SUBJECT}"
          found_subject=1
          ;;
        *)
          echo "\${line}"
          ;;
      esac
    else
      if [ "\${line}" = "Detailed description." ]; then
        echo "\${BODY}"
        break
      else
        echo "\${line}"
      fi
    fi
  done < "$1"
} > "\${temp}"
mv "\${temp}" "$1"
`, { mode: 0o755 });
	
	// Create issue
	const { stdout } = await execCommand("git", ["artemis", "add"], testDir, { 
		...process.env,
		EDITOR: editorScript,
		SUBJECT: "Integration Test Subject",
		BODY: `This is the body text
With multiple lines
For testing`
	});
	
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
	
	// Create editor that modifies the template using SUBJECT/BODY env vars
	const editorScript = join(testDir, "comment-editor.sh");
	writeFileSync(editorScript, `#!/bin/sh
set -e
temp="$1.tmp"
{
  found_subject=0
  while IFS= read -r line || [ -n "\${line}" ]; do
    if [ "\${found_subject}" -eq 0 ]; then
      case "\${line}" in
        Subject:*)
          echo "Subject: \${SUBJECT}"
          found_subject=1
          ;;
        *)
          echo "\${line}"
          ;;
      esac
    else
      if [ "\${line}" = "Detailed description." ]; then
        echo "\${BODY}"
        break
      else
        echo "\${line}"
      fi
    fi
  done < "$1"
} > "\${temp}"
mv "\${temp}" "$1"
`, { mode: 0o755 });
	
	// Add comment
	await execCommand("git", ["artemis", "add", issueId], testDir, { 
		...process.env,
		EDITOR: editorScript,
		SUBJECT: "Re: comment",
		BODY: `This is my comment
With some details
And more info`
	});
	
	// Show the issue (which will list comments in the footer)
	const { stdout: showOutput } = await execCommand("git", ["artemis", "show", issueId], testDir);
	
	// Verify comment appears in the Comments: section
	if (!showOutput.includes("Comments:")) {
		return `Issue doesn't show Comments section. Output:\n${showOutput}`;
	}
	
	if (!showOutput.includes("Re: comment")) {
		return `Comment not listed in issue. Output:\n${showOutput}`;
	}
	
	// List issues to verify comment count
	const { stdout: listOutput } = await execCommand("git", ["artemis", "list", "-a"], testDir);
	
	// Should show (  1) indicating 1 comment
	if (!listOutput.includes("(  1)")) {
		return `Issue doesn't show comment count. Output:\n${listOutput}`;
	}
	
	return true;
});

process.exit(failCount > 0 ? 1 : 0);
