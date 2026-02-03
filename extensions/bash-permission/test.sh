#!/usr/bin/env bash
set -euo pipefail

failed=0

echo "TAP version 13"

# Unit tests - test extension logic without pi
echo "# Unit tests - extension logic"
test_helper="./test-helper.mjs"

tests=(
	"test-config-empty:Config loading - empty config"
	"test-config-populated:Config loading - populated config"
	"test-config-save:Config saving - write and read back"
	"test-match-exact-allow:Command matching - exact allow"
	"test-match-exact-deny:Command matching - exact deny"
	"test-match-prefix-allow:Command matching - prefix allow"
	"test-match-prefix-deny:Command matching - prefix deny"
	"test-match-unknown:Command matching - unknown command"
	"test-priority-exact-deny:Priority order - exact deny over exact allow"
	"test-priority-exact-allow:Priority order - exact allow over prefix deny"
	"test-edge-multiline:Edge case - multi-line command matching"
	"test-edge-pipe:Edge case - piped command matching"
	"test-edge-escaped:Edge case - escaped characters in command"
	"test-edge-empty-prefix:Edge case - empty prefix handling"
)

echo "1..${#tests[@]}"

for test_spec in "${tests[@]}"; do
	test_fn="${test_spec%%:*}"
	test_name="${test_spec#*:}"
	
	if output=$(node "$test_helper" "$test_fn" 2>&1); then
		echo "ok - $test_name"
	else
		failed=1
		echo "not ok - $test_name"
		echo "  # $output"
	fi
done

# Integration tests - test extension with pi
echo ""
echo "# Integration tests - extension with pi"
if ! node ./test-integration.mjs 2>&1; then
	failed=1
fi

# Blocking tests - verify actual command effects
echo ""
echo "# Blocking tests - actual command effects"
if ! node ./test-blocking.mjs 2>&1; then
	failed=1
fi

if [ "$failed" -gt 0 ]; then
	exit 1
fi
