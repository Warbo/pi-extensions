#!/usr/bin/env bash
set -euo pipefail

# TAP test output
test_count=0
failed=0

tap_ok() {
	test_count=$((test_count + 1))
	echo "ok $test_count - $1"
}

tap_not_ok() {
	test_count=$((test_count + 1))
	failed=1
	echo "not ok $test_count - $1"
	if [ -n "${2:-}" ]; then
		echo "  # $2"
	fi
}

# Find the test helper script
test_helper="./test-helper.mjs"

echo "TAP version 13"
echo "1..14" # Update this if adding more tests

# Test 1: Config loading with empty config
test_name="Config loading - empty config"
if output=$(node "$test_helper" test-config-empty 2>&1); then
	tap_ok "$test_name"
else
	tap_not_ok "$test_name" "Output: $output"
fi

# Test 2: Config loading with populated config
test_name="Config loading - populated config"
if output=$(node "$test_helper" test-config-populated 2>&1); then
	tap_ok "$test_name"
else
	tap_not_ok "$test_name" "Output: $output"
fi

# Test 3: Config saving
test_name="Config saving - write and read back"
if output=$(node "$test_helper" test-config-save 2>&1); then
	tap_ok "$test_name"
else
	tap_not_ok "$test_name" "Output: $output"
fi

# Test 4: Command matching - exact allow
test_name="Command matching - exact allow"
if output=$(node "$test_helper" test-match-exact-allow 2>&1); then
	tap_ok "$test_name"
else
	tap_not_ok "$test_name" "Output: $output"
fi

# Test 5: Command matching - exact deny
test_name="Command matching - exact deny"
if output=$(node "$test_helper" test-match-exact-deny 2>&1); then
	tap_ok "$test_name"
else
	tap_not_ok "$test_name" "Output: $output"
fi

# Test 6: Command matching - prefix allow
test_name="Command matching - prefix allow"
if output=$(node "$test_helper" test-match-prefix-allow 2>&1); then
	tap_ok "$test_name"
else
	tap_not_ok "$test_name" "Output: $output"
fi

# Test 7: Command matching - prefix deny
test_name="Command matching - prefix deny"
if output=$(node "$test_helper" test-match-prefix-deny 2>&1); then
	tap_ok "$test_name"
else
	tap_not_ok "$test_name" "Output: $output"
fi

# Test 8: Command matching - unknown command
test_name="Command matching - unknown command"
if output=$(node "$test_helper" test-match-unknown 2>&1); then
	tap_ok "$test_name"
else
	tap_not_ok "$test_name" "Output: $output"
fi

# Test 9: Priority order - exact deny beats exact allow
test_name="Priority order - exact deny over exact allow"
if output=$(node "$test_helper" test-priority-exact-deny 2>&1); then
	tap_ok "$test_name"
else
	tap_not_ok "$test_name" "Output: $output"
fi

# Test 10: Priority order - exact allow beats prefix deny
test_name="Priority order - exact allow over prefix deny"
if output=$(node "$test_helper" test-priority-exact-allow 2>&1); then
	tap_ok "$test_name"
else
	tap_not_ok "$test_name" "Output: $output"
fi

# Test 11: Edge case - multi-line command
test_name="Edge case - multi-line command matching"
if output=$(node "$test_helper" test-edge-multiline 2>&1); then
	tap_ok "$test_name"
else
	tap_not_ok "$test_name" "Output: $output"
fi

# Test 12: Edge case - piped command
test_name="Edge case - piped command matching"
if output=$(node "$test_helper" test-edge-pipe 2>&1); then
	tap_ok "$test_name"
else
	tap_not_ok "$test_name" "Output: $output"
fi

# Test 13: Edge case - command with escaped characters
test_name="Edge case - escaped characters in command"
if output=$(node "$test_helper" test-edge-escaped 2>&1); then
	tap_ok "$test_name"
else
	tap_not_ok "$test_name" "Output: $output"
fi

# Test 14: Edge case - empty prefix shouldn't match
test_name="Edge case - empty prefix handling"
if output=$(node "$test_helper" test-edge-empty-prefix 2>&1); then
	tap_ok "$test_name"
else
	tap_not_ok "$test_name" "Output: $output"
fi

if ! node ./test-integration-simple.mjs 2>&1; then
	failed=1

	# Dump debug logs if they exist
	TEMP_DIR="${TMPDIR:-/tmp}"
	if ls "$TEMP_DIR"/bash-permission-wrapper-*.log >/dev/null 2>&1; then
		for logfile in "$TEMP_DIR"/bash-permission-wrapper-*.log; do
			echo "# File: $logfile"
			cat "$logfile" | sed 's/^/# /'
		done
	else
		echo "# No wrapper logs found"
	fi

	if ls "$TEMP_DIR"/bash-permission-ext-*.log >/dev/null 2>&1; then
		for logfile in "$TEMP_DIR"/bash-permission-ext-*.log; do
			echo "# File: $logfile"
			cat "$logfile" | sed 's/^/# /'
		done
	else
		echo "# No extension logs found"
	fi
fi

if ! ./test-integration.mjs 2>&1; then
	failed=1
fi

if [ "$failed" -gt 0 ]; then
	exit 1
fi
