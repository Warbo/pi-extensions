#!/usr/bin/env node
/**
 * Unit tests for artemis extension
 * Tests parameter validation and command building logic for each tool
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

// Mock parameter validation and command building logic mirroring the extension

class ListIssuesValidator {
	validate(_params) {
		return true; // no required params
	}

	buildArgs(params) {
		return params.all ? ["list", "-a"] : ["list", "-p", "state=new"];
	}
}

class NewIssueValidator {
	validate(params) {
		return !!(params.subject && params.body);
	}

	buildArgs(_params) {
		return ["add"]; // SUBJECT/BODY passed via EDITOR env vars
	}
}

class CommentIssueValidator {
	validate(params) {
		return !!(params.issueId && params.body);
	}

	buildArgs(params) {
		return ["add", params.issueId]; // BODY passed via EDITOR env vars
	}
}

class ShowIssueValidator {
	validate(params) {
		return !!params.issueId;
	}

	buildArgs(params) {
		const args = ["show", params.issueId];
		if (params.commentNumber !== undefined) args.push(String(params.commentNumber));
		return args;
	}
}

class CloseIssueValidator {
	validate(params) {
		return !!(params.issueId && params.body);
	}

	buildArgs(params) {
		return ["add", params.issueId, "-p", "state=resolved", "-p", "resolution=fixed"];
	}
}

const listValidator    = new ListIssuesValidator();
const newValidator     = new NewIssueValidator();
const commentValidator = new CommentIssueValidator();
const showValidator    = new ShowIssueValidator();
const closeValidator   = new CloseIssueValidator();

// ── list_issues ──────────────────────────────────────────────────────────────

runTest("list_issues - valid with no params", () => {
	if (!listValidator.validate({})) throw new Error("Should be valid with no params");
});

runTest("list_issues - valid with all=true", () => {
	if (!listValidator.validate({ all: true })) throw new Error("Should be valid with all=true");
});

runTest("list_issues - builds default args (state=new)", () => {
	const args = listValidator.buildArgs({});
	if (!args.includes("list")) throw new Error("Should include 'list'");
	if (!args.includes("state=new")) throw new Error("Should default to state=new filter");
	if (args.includes("-a")) throw new Error("Should not include -a by default");
});

runTest("list_issues - builds args with all=true", () => {
	const args = listValidator.buildArgs({ all: true });
	if (!args.includes("list")) throw new Error("Should include 'list'");
	if (!args.includes("-a")) throw new Error("Should include -a flag");
	if (args.includes("state=new")) throw new Error("Should not filter when all=true");
});

// ── new_issue ────────────────────────────────────────────────────────────────

runTest("new_issue - requires subject", () => {
	if (newValidator.validate({ body: "Some body" })) throw new Error("Should fail without subject");
});

runTest("new_issue - requires body", () => {
	if (newValidator.validate({ subject: "Some subject" })) throw new Error("Should fail without body");
});

runTest("new_issue - valid with subject and body", () => {
	if (!newValidator.validate({ subject: "Bug found", body: "Details here" }))
		throw new Error("Should be valid with subject and body");
});

runTest("new_issue - empty subject is rejected", () => {
	if (newValidator.validate({ subject: "", body: "Body" })) throw new Error("Empty subject should be rejected");
});

runTest("new_issue - empty body is rejected", () => {
	if (newValidator.validate({ subject: "Subject", body: "" })) throw new Error("Empty body should be rejected");
});

runTest("new_issue - multiline body is valid", () => {
	if (!newValidator.validate({ subject: "Issue", body: "Line 1\nLine 2\nLine 3" }))
		throw new Error("Multiline body should be valid");
});

runTest("new_issue - special characters in subject are valid", () => {
	if (!newValidator.validate({ subject: "Bug: SQL injection in auth.js (critical!)", body: "Details..." }))
		throw new Error("Special chars in subject should be valid");
});

runTest("new_issue - builds correct args", () => {
	const args = newValidator.buildArgs({ subject: "Test Issue", body: "Test Body" });
	if (!args.includes("add")) throw new Error("Should include 'add'");
});

// ── comment_issue ────────────────────────────────────────────────────────────

runTest("comment_issue - requires issueId", () => {
	if (commentValidator.validate({ body: "Comment text" })) throw new Error("Should fail without issueId");
});

runTest("comment_issue - requires body", () => {
	if (commentValidator.validate({ issueId: "abc123" })) throw new Error("Should fail without body");
});

runTest("comment_issue - valid with issueId and body", () => {
	if (!commentValidator.validate({ issueId: "abc123", body: "This is a comment" }))
		throw new Error("Should be valid with issueId and body");
});

runTest("comment_issue - empty body is rejected", () => {
	if (commentValidator.validate({ issueId: "abc123", body: "" })) throw new Error("Empty body should be rejected");
});

runTest("comment_issue - builds correct args", () => {
	const args = commentValidator.buildArgs({ issueId: "abc123", body: "Comment" });
	if (!args.includes("add")) throw new Error("Should include 'add'");
	if (!args.includes("abc123")) throw new Error("Should include issueId");
});

runTest("comment_issue - no subject param (subject unchanged by editor)", () => {
	// comment_issue does not take a subject; the editor leaves the subject line as-is
	if (!commentValidator.validate({ issueId: "abc123", body: "No subject needed" }))
		throw new Error("Should be valid without a subject param");
});

// ── show_issue ───────────────────────────────────────────────────────────────

runTest("show_issue - requires issueId", () => {
	if (showValidator.validate({})) throw new Error("Should fail without issueId");
});

runTest("show_issue - valid with issueId", () => {
	if (!showValidator.validate({ issueId: "abc123" })) throw new Error("Should be valid with issueId");
});

runTest("show_issue - valid with issueId and commentNumber", () => {
	if (!showValidator.validate({ issueId: "abc123", commentNumber: 0 }))
		throw new Error("Should be valid with issueId and commentNumber");
});

runTest("show_issue - commentNumber can be 0", () => {
	if (!showValidator.validate({ issueId: "abc123", commentNumber: 0 }))
		throw new Error("commentNumber 0 should be valid");
});

runTest("show_issue - any issueId format is valid", () => {
	if (!showValidator.validate({ issueId: "any-format-here" }))
		throw new Error("Any issueId format should validate");
});

runTest("show_issue - builds args without commentNumber", () => {
	const args = showValidator.buildArgs({ issueId: "abc123" });
	if (!args.includes("show")) throw new Error("Should include 'show'");
	if (!args.includes("abc123")) throw new Error("Should include issueId");
	if (args.length !== 2) throw new Error("Should only have 'show' and issueId");
});

runTest("show_issue - builds args with commentNumber", () => {
	const args = showValidator.buildArgs({ issueId: "abc123", commentNumber: 2 });
	if (!args.includes("show")) throw new Error("Should include 'show'");
	if (!args.includes("abc123")) throw new Error("Should include issueId");
	if (!args.includes("2")) throw new Error("Should include commentNumber as string");
});

// ── close_issue ──────────────────────────────────────────────────────────────

runTest("close_issue - requires issueId", () => {
	if (closeValidator.validate({ body: "Closing comment" })) throw new Error("Should fail without issueId");
});

runTest("close_issue - requires body", () => {
	if (closeValidator.validate({ issueId: "abc123" })) throw new Error("Should fail without body");
});

runTest("close_issue - valid with issueId and body", () => {
	if (!closeValidator.validate({ issueId: "abc123", body: "Fixed and closed" }))
		throw new Error("Should be valid with issueId and body");
});

runTest("close_issue - empty body is rejected", () => {
	if (closeValidator.validate({ issueId: "abc123", body: "" })) throw new Error("Empty body should be rejected");
});

runTest("close_issue - builds correct args", () => {
	const args = closeValidator.buildArgs({ issueId: "abc123", body: "Fixed and closed" });
	if (!args.includes("add")) throw new Error("Should use 'add' subcommand");
	if (!args.includes("abc123")) throw new Error("Should include issueId");
	if (!args.includes("state=resolved")) throw new Error("Should set state=resolved");
	if (!args.includes("resolution=fixed")) throw new Error("Should set resolution=fixed");
});

process.exit(failCount > 0 ? 1 : 0);
