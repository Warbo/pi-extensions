#!/usr/bin/env node
/**
 * Unit tests for artemis extension
 * Tests parameter validation and command building logic
 */

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
		testFn();
		testPass(name);
	} catch (error) {
		testFail(name, error.message);
	}
}

// Mock parameter validation logic
class ArtemisValidator {
	validateList(params) {
		if (params.command !== "list") return false;
		return true;
	}

	validateAdd(params) {
		if (params.command !== "add") return false;
		
		// Creating new issue
		if (!params.issueId) {
			return params.subject && params.body;
		}
		
		// Adding comment
		return params.commentBody !== undefined;
	}

	validateShow(params) {
		if (params.command !== "show") return false;
		return params.issueId !== undefined;
	}

	validateClose(params) {
		if (params.command !== "close") return false;
		return params.issueId !== undefined;
	}

	buildCommand(params) {
		const args = [];
		
		if (params.command === "list") {
			args.push("list");
			if (!params.all) {
				args.push("-p", "state=new");
			} else {
				args.push("-a");
			}
		} else if (params.command === "add") {
			args.push("add");
			if (params.issueId) {
				args.push(params.issueId);
			} else {
				args.push("-m", params.subject);
			}
		} else if (params.command === "show") {
			args.push("show", params.issueId);
			if (params.commentNumber !== undefined) {
				args.push(String(params.commentNumber));
			}
		} else if (params.command === "close") {
			args.push("add", params.issueId, "-p", "state=resolved", "-p", "resolution=fixed", "-n");
		}
		
		return args;
	}
}

const validator = new ArtemisValidator();

// List command tests
runTest("List command - basic validation", () => {
	const result = validator.validateList({ command: "list" });
	if (!result) throw new Error("Basic list should be valid");
});

runTest("List command - with all flag", () => {
	const result = validator.validateList({ command: "list", all: true });
	if (!result) throw new Error("List with all flag should be valid");
});

runTest("List command - builds correct args (default)", () => {
	const args = validator.buildCommand({ command: "list" });
	if (!args.includes("list")) throw new Error("Should include 'list'");
	if (!args.includes("state=new")) throw new Error("Should default to state=new filter");
});

runTest("List command - builds correct args (all)", () => {
	const args = validator.buildCommand({ command: "list", all: true });
	if (!args.includes("list")) throw new Error("Should include 'list'");
	if (!args.includes("-a")) throw new Error("Should include -a flag");
	if (args.includes("state=new")) throw new Error("Should not filter when all=true");
});

// Add command tests - new issue
runTest("Add command - new issue requires subject", () => {
	const result = validator.validateAdd({ 
		command: "add", 
		body: "Some body" 
	});
	if (result) throw new Error("Should fail without subject");
});

runTest("Add command - new issue requires body", () => {
	const result = validator.validateAdd({ 
		command: "add", 
		subject: "Some subject" 
	});
	if (result) throw new Error("Should fail without body");
});

runTest("Add command - new issue valid with subject and body", () => {
	const result = validator.validateAdd({ 
		command: "add", 
		subject: "Bug found", 
		body: "Details here" 
	});
	if (!result) throw new Error("Should be valid with subject and body");
});

runTest("Add command - new issue builds correct args", () => {
	const args = validator.buildCommand({ 
		command: "add", 
		subject: "Test Issue", 
		body: "Test Body" 
	});
	if (!args.includes("add")) throw new Error("Should include 'add'");
	if (!args.includes("-m")) throw new Error("Should include -m flag");
	if (!args.includes("Test Issue")) throw new Error("Should include subject");
});

// Add command tests - comment
runTest("Add command - comment requires issueId", () => {
	const result = validator.validateAdd({ 
		command: "add", 
		commentBody: "Comment text" 
	});
	if (result) throw new Error("Should fail without issueId for comment");
});

runTest("Add command - comment requires commentBody", () => {
	const result = validator.validateAdd({ 
		command: "add", 
		issueId: "abc123" 
	});
	if (result) throw new Error("Should fail without commentBody");
});

runTest("Add command - comment valid with issueId and commentBody", () => {
	const result = validator.validateAdd({ 
		command: "add", 
		issueId: "abc123", 
		commentBody: "This is a comment" 
	});
	if (!result) throw new Error("Should be valid with issueId and commentBody");
});

runTest("Add command - comment builds correct args", () => {
	const args = validator.buildCommand({ 
		command: "add", 
		issueId: "abc123", 
		commentBody: "Comment" 
	});
	if (!args.includes("add")) throw new Error("Should include 'add'");
	if (!args.includes("abc123")) throw new Error("Should include issueId");
});

// Show command tests
runTest("Show command - requires issueId", () => {
	const result = validator.validateShow({ command: "show" });
	if (result) throw new Error("Should fail without issueId");
});

runTest("Show command - valid with issueId", () => {
	const result = validator.validateShow({ 
		command: "show", 
		issueId: "abc123" 
	});
	if (!result) throw new Error("Should be valid with issueId");
});

runTest("Show command - valid with issueId and commentNumber", () => {
	const result = validator.validateShow({ 
		command: "show", 
		issueId: "abc123", 
		commentNumber: 0 
	});
	if (!result) throw new Error("Should be valid with issueId and commentNumber");
});

runTest("Show command - builds correct args (issue only)", () => {
	const args = validator.buildCommand({ 
		command: "show", 
		issueId: "abc123" 
	});
	if (!args.includes("show")) throw new Error("Should include 'show'");
	if (!args.includes("abc123")) throw new Error("Should include issueId");
});

runTest("Show command - builds correct args (with comment)", () => {
	const args = validator.buildCommand({ 
		command: "show", 
		issueId: "abc123", 
		commentNumber: 2 
	});
	if (!args.includes("show")) throw new Error("Should include 'show'");
	if (!args.includes("abc123")) throw new Error("Should include issueId");
	if (!args.includes("2")) throw new Error("Should include commentNumber");
});

// Close command tests
runTest("Close command - requires issueId", () => {
	const result = validator.validateClose({ command: "close" });
	if (result) throw new Error("Should fail without issueId");
});

runTest("Close command - valid with issueId", () => {
	const result = validator.validateClose({ 
		command: "close", 
		issueId: "abc123" 
	});
	if (!result) throw new Error("Should be valid with issueId");
});

runTest("Close command - builds correct args", () => {
	const args = validator.buildCommand({ 
		command: "close", 
		issueId: "abc123" 
	});
	if (!args.includes("add")) throw new Error("Should use 'add' subcommand");
	if (!args.includes("abc123")) throw new Error("Should include issueId");
	if (!args.includes("state=resolved")) throw new Error("Should set state=resolved");
	if (!args.includes("resolution=fixed")) throw new Error("Should set resolution=fixed");
	if (!args.includes("-n")) throw new Error("Should include -n flag");
});

// Edge cases
runTest("Edge case - empty subject rejected", () => {
	// Empty string is falsy and should be rejected
	const result = validator.validateAdd({ 
		command: "add", 
		subject: "", 
		body: "Body" 
	});
	if (result) throw new Error("Empty subject should be rejected");
});

runTest("Edge case - multiline body handled", () => {
	const result = validator.validateAdd({ 
		command: "add", 
		subject: "Issue", 
		body: "Line 1\nLine 2\nLine 3" 
	});
	if (!result) throw new Error("Multiline body should be valid");
});

runTest("Edge case - special characters in subject", () => {
	const result = validator.validateAdd({ 
		command: "add", 
		subject: "Bug: SQL injection in auth.js (critical!)", 
		body: "Details..." 
	});
	if (!result) throw new Error("Special chars in subject should be valid");
});

runTest("Edge case - commentNumber can be 0", () => {
	const result = validator.validateShow({ 
		command: "show", 
		issueId: "abc123", 
		commentNumber: 0 
	});
	if (!result) throw new Error("commentNumber 0 should be valid");
});

runTest("Edge case - issueId format not validated", () => {
	// The extension doesn't validate issueId format, git artemis will handle that
	const result = validator.validateShow({ 
		command: "show", 
		issueId: "any-format-here" 
	});
	if (!result) throw new Error("Any issueId format should validate");
});

runTest("Edge case - body parameter is required for new issue", () => {
	const result = validator.validateAdd({ 
		command: "add", 
		subject: "Test" 
	});
	if (result) throw new Error("Should fail without body");
});

runTest("Edge case - empty body should be rejected", () => {
	const result = validator.validateAdd({ 
		command: "add", 
		subject: "Test",
		body: "" 
	});
	if (result) throw new Error("Empty body should be rejected");
});

process.exit(failCount > 0 ? 1 : 0);
