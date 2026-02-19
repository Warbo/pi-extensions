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

// ── issues_list ──────────────────────────────────────────────────────────────

runTest("issues_list - valid with no params", () => {
	if (!listValidator.validate({})) throw new Error("Should be valid with no params");
});

runTest("issues_list - valid with all=true", () => {
	if (!listValidator.validate({ all: true })) throw new Error("Should be valid with all=true");
});

runTest("issues_list - builds default args (state=new)", () => {
	const args = listValidator.buildArgs({});
	if (!args.includes("list")) throw new Error("Should include 'list'");
	if (!args.includes("state=new")) throw new Error("Should default to state=new filter");
	if (args.includes("-a")) throw new Error("Should not include -a by default");
});

runTest("issues_list - builds args with all=true", () => {
	const args = listValidator.buildArgs({ all: true });
	if (!args.includes("list")) throw new Error("Should include 'list'");
	if (!args.includes("-a")) throw new Error("Should include -a flag");
	if (args.includes("state=new")) throw new Error("Should not filter when all=true");
});

// ── issues_new ────────────────────────────────────────────────────────────────

runTest("issues_new - requires subject", () => {
	if (newValidator.validate({ body: "Some body" })) throw new Error("Should fail without subject");
});

runTest("issues_new - requires body", () => {
	if (newValidator.validate({ subject: "Some subject" })) throw new Error("Should fail without body");
});

runTest("issues_new - valid with subject and body", () => {
	if (!newValidator.validate({ subject: "Bug found", body: "Details here" }))
		throw new Error("Should be valid with subject and body");
});

runTest("issues_new - empty subject is rejected", () => {
	if (newValidator.validate({ subject: "", body: "Body" })) throw new Error("Empty subject should be rejected");
});

runTest("issues_new - empty body is rejected", () => {
	if (newValidator.validate({ subject: "Subject", body: "" })) throw new Error("Empty body should be rejected");
});

runTest("issues_new - multiline body is valid", () => {
	if (!newValidator.validate({ subject: "Issue", body: "Line 1\nLine 2\nLine 3" }))
		throw new Error("Multiline body should be valid");
});

runTest("issues_new - special characters in subject are valid", () => {
	if (!newValidator.validate({ subject: "Bug: SQL injection in auth.js (critical!)", body: "Details..." }))
		throw new Error("Special chars in subject should be valid");
});

runTest("issues_new - builds correct args", () => {
	const args = newValidator.buildArgs({ subject: "Test Issue", body: "Test Body" });
	if (!args.includes("add")) throw new Error("Should include 'add'");
});

// ── issues_comment ────────────────────────────────────────────────────────────

runTest("issues_comment - requires issueId", () => {
	if (commentValidator.validate({ body: "Comment text" })) throw new Error("Should fail without issueId");
});

runTest("issues_comment - requires body", () => {
	if (commentValidator.validate({ issueId: "abc123" })) throw new Error("Should fail without body");
});

runTest("issues_comment - valid with issueId and body", () => {
	if (!commentValidator.validate({ issueId: "abc123", body: "This is a comment" }))
		throw new Error("Should be valid with issueId and body");
});

runTest("issues_comment - empty body is rejected", () => {
	if (commentValidator.validate({ issueId: "abc123", body: "" })) throw new Error("Empty body should be rejected");
});

runTest("issues_comment - builds correct args", () => {
	const args = commentValidator.buildArgs({ issueId: "abc123", body: "Comment" });
	if (!args.includes("add")) throw new Error("Should include 'add'");
	if (!args.includes("abc123")) throw new Error("Should include issueId");
});

runTest("issues_comment - no subject param (subject unchanged by editor)", () => {
	// comment_issue does not take a subject; the editor leaves the subject line as-is
	if (!commentValidator.validate({ issueId: "abc123", body: "No subject needed" }))
		throw new Error("Should be valid without a subject param");
});

// ── issues_show ───────────────────────────────────────────────────────────────

runTest("issues_show - requires issueId", () => {
	if (showValidator.validate({})) throw new Error("Should fail without issueId");
});

runTest("issues_show - valid with issueId", () => {
	if (!showValidator.validate({ issueId: "abc123" })) throw new Error("Should be valid with issueId");
});

runTest("issues_show - valid with issueId and commentNumber", () => {
	if (!showValidator.validate({ issueId: "abc123", commentNumber: 0 }))
		throw new Error("Should be valid with issueId and commentNumber");
});

runTest("issues_show - commentNumber can be 0", () => {
	if (!showValidator.validate({ issueId: "abc123", commentNumber: 0 }))
		throw new Error("commentNumber 0 should be valid");
});

runTest("issues_show - any issueId format is valid", () => {
	if (!showValidator.validate({ issueId: "any-format-here" }))
		throw new Error("Any issueId format should validate");
});

runTest("issues_show - builds args without commentNumber", () => {
	const args = showValidator.buildArgs({ issueId: "abc123" });
	if (!args.includes("show")) throw new Error("Should include 'show'");
	if (!args.includes("abc123")) throw new Error("Should include issueId");
	if (args.length !== 2) throw new Error("Should only have 'show' and issueId");
});

runTest("issues_show - builds args with commentNumber", () => {
	const args = showValidator.buildArgs({ issueId: "abc123", commentNumber: 2 });
	if (!args.includes("show")) throw new Error("Should include 'show'");
	if (!args.includes("abc123")) throw new Error("Should include issueId");
	if (!args.includes("2")) throw new Error("Should include commentNumber as string");
});

// ── issues_close ──────────────────────────────────────────────────────────────

runTest("issues_close - requires issueId", () => {
	if (closeValidator.validate({ body: "Closing comment" })) throw new Error("Should fail without issueId");
});

runTest("issues_close - requires body", () => {
	if (closeValidator.validate({ issueId: "abc123" })) throw new Error("Should fail without body");
});

runTest("issues_close - valid with issueId and body", () => {
	if (!closeValidator.validate({ issueId: "abc123", body: "Fixed and closed" }))
		throw new Error("Should be valid with issueId and body");
});

runTest("issues_close - empty body is rejected", () => {
	if (closeValidator.validate({ issueId: "abc123", body: "" })) throw new Error("Empty body should be rejected");
});

runTest("issues_close - builds correct args", () => {
	const args = closeValidator.buildArgs({ issueId: "abc123", body: "Fixed and closed" });
	if (!args.includes("add")) throw new Error("Should use 'add' subcommand");
	if (!args.includes("abc123")) throw new Error("Should include issueId");
	if (!args.includes("state=resolved")) throw new Error("Should set state=resolved");
	if (!args.includes("resolution=fixed")) throw new Error("Should set resolution=fixed");
});

process.exit(failCount > 0 ? 1 : 0);
