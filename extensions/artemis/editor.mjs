/**
 * Helper functions to create editor scripts for git artemis
 * 
 * Artemis expects EDITOR to modify the template in place.
 * We use SUBJECT and BODY environment variables that the editor script reads.
 */

import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Creates a shell script that modifies an artemis template using SUBJECT and BODY env vars
 * 
 * The script processes the template line-by-line:
 * 1. Outputs lines as-is until it finds "Subject:"
 * 2. When it finds "Subject:":
 *    - If SUBJECT env var is set (non-empty), replaces the line with "Subject: $SUBJECT"
 *    - If SUBJECT is absent/empty, leaves the Subject: line unchanged (correct for comments)
 * 3. Continues outputting lines as-is until it finds "Detailed description."
 * 4. When it finds "Detailed description.", replaces it with "$BODY" and stops
 * 
 * This matches the artemis test suite's EDITOR script approach.
 */
export function createEditorScript() {
	return `#!/bin/sh
set -e

# Use a temp file to build the modified template
temp="$1.tmp"

{
  # First loop: Output lines until we find Subject:, then replace it
  found_subject=0
  while IFS= read -r line || [ -n "\${line}" ]; do
    if [ "\${found_subject}" -eq 0 ]; then
      case "\${line}" in
        Subject:*)
          if [ -n "\${SUBJECT}" ]; then
            echo "Subject: \${SUBJECT}"
          else
            echo "\${line}"
          fi
          found_subject=1
          ;;
        *)
          echo "\${line}"
          ;;
      esac
    else
      # After subject, look for "Detailed description."
      if [ "\${line}" = "Detailed description." ]; then
        # Replace placeholder with body and stop processing
        # Use printf to handle newlines in the BODY variable
        printf '%s\n' "\${BODY}"
        break
      else
        echo "\${line}"
      fi
    fi
  done < "$1"
} > "\${temp}"

# Replace original with modified version
mv "\${temp}" "$1"
`;
}

/**
 * Writes an editor script to a temporary file with execute permissions
 */
export async function writeEditorScript(scriptContent) {
	const scriptPath = join(tmpdir(), `artemis-editor-${Date.now()}-${Math.random().toString(36).slice(2)}.sh`);
	await writeFile(scriptPath, scriptContent, { mode: 0o755 });
	return scriptPath;
}
