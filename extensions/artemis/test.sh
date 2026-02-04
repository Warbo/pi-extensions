#!/usr/bin/env bash
set -euo pipefail

# Check if the extension file exists
if [ ! -f "index.ts" ]; then
    echo "not ok - index.ts not found"
    exit 1
fi

# Check that the file has basic structure
if ! grep -q "export default function" index.ts; then
    echo "not ok - Missing default export function"
    exit 1
fi

if ! grep -q "pi.registerTool" index.ts; then
    echo "not ok - Missing tool registration"
    exit 1
fi

# Check for git-artemis installation
if ! command -v git-artemis &> /dev/null; then
    echo "not ok - git-artemis not found"
    echo "  # This extension requires the artemis package in buildInputs"
    exit 1
fi

CODE=0
node ./unit_test.mjs || CODE=1
node ./integration_test.mjs || CODE=1

exit "$CODE"
