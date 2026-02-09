#!/usr/bin/env bash
set -euo pipefail

# Check that the extension file exists
if [ ! -f "index.ts" ]; then
    echo "not ok - index.ts not found"
    exit 1
fi

# Check that the file has basic structure
if ! grep -q "export default function" index.ts; then
    echo "not ok - Missing default export function"
    exit 1
fi

if ! grep -q "pi.registerProvider" index.ts; then
    echo "not ok - Missing provider registration"
    exit 1
fi

if ! grep -q 'api:.*"react"' index.ts; then
    echo "not ok - Missing react api type registration"
    exit 1
fi

if ! grep -q "streamSimple" index.ts; then
    echo "not ok - Missing streamSimple registration"
    exit 1
fi

CODE=0
node ./unit_test.mjs || CODE=1
node ./integration_test.mjs || CODE=1
exit "$CODE"
