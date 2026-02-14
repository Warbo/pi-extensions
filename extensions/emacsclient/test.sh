#!/usr/bin/env bash
set -euo pipefail

# Check that the extension file exists and has basic structure
if [ ! -f "index.ts" ]; then
    echo "not ok - index.ts not found"
    exit 1
fi

if ! grep -q "export default function" index.ts; then
    echo "not ok - Missing default export function"
    exit 1
fi

if ! grep -q "pi.registerTool" index.ts; then
    echo "not ok - Missing tool registration"
    exit 1
fi

for tool in emacs_eval emacs_list_buffers emacs_buffer_contents emacs_ts_query; do
    if ! grep -q "name: \"$tool\"" index.ts; then
        echo "not ok - Missing tool: $tool"
        exit 1
    fi
done

CODE=0
echo "# Running unit tests..."
node ./unit_test.mjs || CODE=1
echo "# Running Emacs integration tests..."
node ./emacs-integration.mjs || CODE=1
echo "# Running Pi integration tests..."
node ./pi-integration.mjs || CODE=1
exit "$CODE"
