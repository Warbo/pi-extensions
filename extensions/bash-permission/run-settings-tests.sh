#!/usr/bin/env bash
set -euo pipefail

# Run the pi settings tests standalone (not through Nix)
cd "$(dirname "$0")"

# We need the wrapper for some tests
export bashPermissionWrapper="${bashPermissionWrapper:-/tmp/fake-wrapper}"

# Create a fake wrapper for testing if not in Nix
if [ ! -f "$bashPermissionWrapper" ]; then
	echo "Creating temporary fake wrapper at $bashPermissionWrapper"
	cat > "$bashPermissionWrapper" << 'EOF'
#!/bin/bash
echo "Fake wrapper invoked" >&2
exec bash "$@"
EOF
	chmod +x "$bashPermissionWrapper"
	trap "rm -f '$bashPermissionWrapper'" EXIT
fi

./test-pi-settings.mjs
