/**
 * Emacsclient invocation. Runs emacsclient with --eval and returns the result.
 */

import { parseEmacsclientOutput, parseEmacsclientError } from "./elisp.ts";

export interface EmacsclientOptions {
  /** Path to emacsclient binary. Default: "emacsclient" */
  binary?: string;
  /** Socket name or path for the Emacs server. Default: from EMACS_SOCKET_NAME env. */
  socketName?: string;
  /** Timeout in milliseconds. Default: 10000 */
  timeout?: number;
  /** AbortSignal for cancellation */
  signal?: AbortSignal;
  /** exec function (injected for testability, defaults to pi.exec) */
  exec: (
    cmd: string,
    args: string[],
    opts?: { signal?: AbortSignal; timeout?: number }
  ) => Promise<{ stdout: string; stderr: string; code: number | null }>;
}

export interface EmacsclientResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

/**
 * Evaluate an elisp expression via emacsclient and return the parsed result.
 */
export async function emacsEval(
  elisp: string,
  options: EmacsclientOptions
): Promise<EmacsclientResult> {
  const binary = options.binary ?? "emacsclient";
  const timeout = options.timeout ?? 10000;

  const args: string[] = ["--eval", elisp];

  // Add socket if specified
  const socket = options.socketName ?? process.env.EMACS_SOCKET_NAME;
  if (socket) {
    args.unshift("--socket-name", socket);
  }

  try {
    const result = await options.exec(binary, args, {
      signal: options.signal,
      timeout,
    });

    if (result.code !== 0) {
      return {
        success: false,
        error: parseEmacsclientError(result.stderr || result.stdout),
      };
    }

    const parsed = parseEmacsclientOutput(result.stdout);
    return { success: true, data: parsed };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
