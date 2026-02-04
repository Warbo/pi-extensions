/**
 * Helper functions to create editor scripts for git artemis
 */

import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Creates a shell script that replaces the subject and body in a git artemis template
 */
export function createIssueEditorScript(subjectFile, bodyFile) {
	return `#!/bin/sh
{
  while IFS= read -r line || [ -n "\${line}" ]; do
    case "\${line}" in
      Subject:*)
        printf "Subject: "
        cat '${subjectFile}'
        echo ""
        ;;
      "Detailed description.")
        cat '${bodyFile}'
        ;;
      *)
        echo "\${line}"
        ;;
    esac
  done < "$1"
} > "$1.tmp" && mv "$1.tmp" "$1"
`;
}

/**
 * Creates a shell script that replaces the body in a git artemis comment template
 */
export function createCommentEditorScript(bodyFile) {
	return `#!/bin/sh
{
  while IFS= read -r line || [ -n "\${line}" ]; do
    if [ "\${line}" = "Detailed description." ]; then
      cat '${bodyFile}'
    else
      echo "\${line}"
    fi
  done < "$1"
} > "$1.tmp" && mv "$1.tmp" "$1"
`;
}

/**
 * Writes an editor script to a temporary file
 */
export async function writeEditorScript(scriptContent) {
	const scriptPath = join(tmpdir(), `artemis-editor-${Date.now()}-${Math.random().toString(36).slice(2)}.sh`);
	await writeFile(scriptPath, scriptContent, { mode: 0o755 });
	return scriptPath;
}
