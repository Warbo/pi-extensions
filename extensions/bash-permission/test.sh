#!/usr/bin/env bash
set -euo pipefail

CODE=0
node ./unit_test.mjs || CODE=1
node ./integration_test.mjs || CODE=1
exit "$CODE"
