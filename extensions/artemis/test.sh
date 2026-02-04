#!/usr/bin/env bash
set -euo pipefail

echo "Testing artemis extension..."

# Check if the extension file exists
if [ ! -f "index.ts" ]; then
    echo "Error: index.ts not found"
    exit 1
fi

# Check that the file has basic structure
if ! grep -q "export default function" index.ts; then
    echo "Error: Missing default export function"
    exit 1
fi

if ! grep -q "pi.registerTool" index.ts; then
    echo "Error: Missing tool registration"
    exit 1
fi

echo "✓ Artemis extension tests passed"
exit 0
