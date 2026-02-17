/**
 * Emacsclient extension for pi.
 *
 * Provides tools for interacting with a running Emacs session:
 *   - read: Read files/buffers with comprehensive metadata and navigation
 *   - emacs_eval: Evaluate arbitrary elisp
 *   - emacs_list_buffers: List open buffers
 *   - emacs_ts_query: Run tree-sitter queries against buffers
 *
 * Requires an Emacs server running (emacs --daemon or M-x server-start).
 * Set EMACS_SOCKET_NAME to specify a non-default socket.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
  buildListBuffersElisp,
  buildTsQueryElisp,
  buildEvalElisp,
  buildReadElisp,
  buildWriteElisp,
} from "./elisp.ts";
import { emacsEval } from "./emacsclient.ts";
import type { EmacsclientOptions } from "./emacsclient.ts";

export default function (pi: ExtensionAPI) {
  // Build shared emacsclient options using pi.exec
  function getOptions(signal?: AbortSignal): EmacsclientOptions {
    return {
      // Allow tests to override emacsclient binary via environment variable
      binary: process.env.EMACSCLIENT_BINARY || "emacsclient",
      exec: (cmd, args, opts) =>
        pi.exec(cmd, args, {
          signal: opts?.signal,
          timeout: opts?.timeout,
        }),
      signal,
    };
  }

  // ------------------------------------------------------------------
  // Tool: emacs_eval
  // ------------------------------------------------------------------
  pi.registerTool({
    name: "emacs_eval",
    label: "Emacs Eval",
    description:
      "Eval a small ELisp expression in our long-running Emacs session and " +
        "return its result. Do not use for big expressions (write those in " +
        "buffers instead). Emacs buffers can be used to store state." +
        "Use other tools where possible; this is to complement them.",
    parameters: Type.Object({
      expression: Type.String({
        description: "Emacs Lisp expression to evaluate",
      }),
    }),
    async execute(toolCallId, params, signal) {
      const elisp = buildEvalElisp(params.expression);
      const result = await emacsEval(elisp, getOptions(signal));

      if (!result.success) {
        return {
          content: [{ type: "text", text: `Error: ${result.error}` }],
          details: { error: result.error },
          isError: true,
        };
      }

      const text =
        typeof result.data === "string"
          ? result.data
          : JSON.stringify(result.data, null, 2);

      return {
        content: [{ type: "text", text }],
        details: { result: result.data },
      };
    },
  });

  // ------------------------------------------------------------------
  // Tool: emacs_list_buffers
  // ------------------------------------------------------------------
  pi.registerTool({
    name: "emacs_list_buffers",
    label: "Emacs List Buffers",
    description:
      "List details of open Emacs buffers. " +
      "Hidden/internal buffers (names starting with space) are excluded.",
    parameters: Type.Object({}),
    async execute(toolCallId, _params, signal) {
      const elisp = buildListBuffersElisp();
      const result = await emacsEval(elisp, getOptions(signal));

      if (!result.success) {
        return {
          content: [{ type: "text", text: `Error: ${result.error}` }],
          details: { error: result.error },
          isError: true,
        };
      }

      const buffers = result.data as Array<Record<string, unknown>>;
      const text = JSON.stringify(buffers, null, 2);

      return {
        content: [{ type: "text", text }],
        details: { buffers },
      };
    },
  });

  // ------------------------------------------------------------------
  // Tool: emacs_ts_query
  // ------------------------------------------------------------------
  pi.registerTool({
    name: "emacs_ts_query",
    label: "Emacs TreeSitter Query",
    description:
      "Run a tree-sitter query against an Emacs buffer and optionally execute " +
      "an elisp action for each match. Returns the list of results. " +
      "Use this for structural code queries and syntax-aware edits.",
    parameters: Type.Object({
      buffer: Type.String({
        description: "Buffer name or file path",
      }),
      query: Type.String({
        description:
          'Tree-sitter query with @captures, e.g. "(function_definition name: (identifier) @name)"',
      }),
      lang: Type.Optional(
        Type.String({
          description:
            "Tree-sitter language hint (e.g. python, javascript). Auto-detected if omitted.",
        })
      ),
      action: Type.Optional(
        Type.String({
          description:
            "Elisp expression to evaluate for each match. " +
            "Each @capture from the query is bound as a variable holding the tree-sitter node. " +
            'Defaults to returning the matched node text. Example: \'(treesit-node-text node t)\'',
        })
      ),
    }),
    async execute(toolCallId, params, signal) {
      const elisp = buildTsQueryElisp(
        params.buffer,
        params.query,
        params.lang,
        params.action
      );
      const result = await emacsEval(elisp, getOptions(signal));

      if (!result.success) {
        return {
          content: [{ type: "text", text: `Error: ${result.error}` }],
          details: { error: result.error },
          isError: true,
        };
      }

      const results = result.data as string[];
      const text = JSON.stringify({ results, count: results.length }, null, 2);

      return {
        content: [{ type: "text", text }],
        details: { results },
      };
    },
  });

  // ------------------------------------------------------------------
  // Tool: read
  // ------------------------------------------------------------------
  pi.registerTool({
    name: "read",
    label: "Read File/Buffer",
    description:
      "Read content & state of an Emacs buffer (existing or new) up to a max " +
        "length (51200 chars). Can open paths (file/dir); can move point; " +
        "can limit chars/lines read. Builds up state in Emacs, to aid later " +
        "reads/edits/etc.; unless 'temp' is given."
    ,
    parameters: Type.Object({
      name: Type.String({
        description:
          "Treated as a path if it contains a '/' (relative can use './'), " +
            "otherwise as a buffer name. Supports TRAMP paths.",
      }),
      pos: Type.Optional(
        Type.Number({
          description:
            "Position to begin reading buffer. +ve is absolute (1-indexed)," +
              "-ve is backwards from point. Omit to use point (or use 0). " +
              "Point is moved to this position, unless 'temp' is true.",
        })
      ),
      line: Type.Optional(
        Type.Number({
          description:
            "Same as 'pos' but for lines. If both are given, 'pos' is used.",
        })
      ),
      col: Type.Optional(
        Type.Number({
          description:
            "Optional column number to begin reading buffer, if using 'line'.",
        })
      ),
      length: Type.Optional(
        Type.Number({
          description:
            "Number of characters to read from buffer. Result may be " +
              "shorter due to end-of-buffer, truncation to max length, or " +
              "due to 'lines'. Defaults to max length (51200).",
        })
      ),
      lines: Type.Optional(
        Type.Number({
          description:
            "Number of lines to read. Result may be shorter due to " +
              "end-of-buffer, or truncation to 'length' chars.",
        })
      ),
      temp: Type.Optional(
        Type.Boolean({
          description:
            "Leaves Emacs state unchanged: new buffers will be killed, " +
              "existing buffers will have their point position restored. " +
            "Lets us read files without affecting Emacs state. Default: false.",
          default: false,
        })
      ),
    }),
    async execute(toolCallId, params, signal) {
      const maxLength = 51200; // Default max length
      const elisp = buildReadElisp(
        params.name,
        {
          pos: params.pos,
          line: params.line,
          col: params.col,
          length: params.length,
          lines: params.lines,
          temp: params.temp,
        },
        maxLength
      );
      const result = await emacsEval(elisp, getOptions(signal));

      if (!result.success) {
        return {
          content: [{ type: "text", text: `Error: ${result.error}` }],
          details: { error: result.error },
          isError: true,
        };
      }

      const data = result.data as Record<string, unknown>;
      const text = JSON.stringify(data, null, 2);

      return {
        content: [{ type: "text", text }],
        details: data,
      };
    },
  });

  // ------------------------------------------------------------------
  // Tool: write
  // ------------------------------------------------------------------
  pi.registerTool({
    name: "write",
    label: "Write to File/Buffer",
    description:
      "Insert text into Emacs buffer at a specific position. Can create new " +
        "files/buffers, move point, insert content, and optionally save. " +
        "Use 'temp' to restore point and close newly opened buffers.",
    parameters: Type.Object({
      name: Type.String({
        description:
          "Treated as path if contains '/', otherwise a buffer name. " +
          "Relative paths can use './'. Supports TRAMP paths.",
      }),
      insert: Type.String({
        description: "Text to insert at the specified position.",
      }),
      pos: Type.Optional(
        Type.Number({
          description:
            "Position to insert at. Positive counts from start of buffer " +
              "(1-indexed); negative counts back from end. Conflicts with " +
              "'line' and 'point'.",
        })
      ),
      line: Type.Optional(
        Type.Number({
          description:
            "Line number to insert at. Positive is from start (1-indexed), " +
            "negative counts back from end. Conflicts with 'pos' and 'point'.",
        })
      ),
      point: Type.Optional(
        Type.Boolean({
          description:
            "true to insert at point (start of file if newly opened). " +
              "Default when no 'pos' or 'line' given. Conflicts with those.",
          default: false,
        })
      ),
      save: Type.Optional(
        Type.Boolean({
          description:
            "true to save buffer to disk after inserting. Only works for " +
              "file-backed buffers. Creates parent directories if needed.",
          default: false,
        })
      ),
      temp: Type.Optional(
        Type.Boolean({
          description:
            "true to restore Emacs state afterwards: killing new buffers, " +
            "restoring point in existing buffers.",
          default: false,
        })
      ),
    }),
    async execute(toolCallId, params, signal) {
      const elisp = buildWriteElisp(
        params.name,
        params.insert,
        {
          pos: params.pos,
          line: params.line,
          point: params.point,
          save: params.save,
          temp: params.temp,
        }
      );
      const result = await emacsEval(elisp, getOptions(signal));

      if (!result.success) {
        return {
          content: [{ type: "text", text: `Error: ${result.error}` }],
          details: { error: result.error },
          isError: true,
        };
      }

      const data = result.data as Record<string, unknown>;
      const text = JSON.stringify(data, null, 2);

      return {
        content: [{ type: "text", text }],
        details: data,
      };
    },
  });
}
