// ── GMAIL_SAFE_MODE: read + draft only (opt-in) ─────────────────────────────
//
// For untrusted deployments (e.g. a shared cloud box / autonomous agent) that
// should be able to READ mail and CREATE/EDIT drafts, but must NEVER send,
// delete, archive, relabel, or change filters.
//
// Enforcement is layered (belt + suspenders):
//   1. installSafeMode() wraps server.registerTool so only allowlisted tools
//      register at all — an absent tool cannot be listed or called.
//   2. assertSafeModeToolset() runs AFTER all registrations and hard-fails boot
//      if any non-allowlisted tool reached the registry via some other path
//      (e.g. the SDK's legacy server.tool()). This makes the default-deny
//      promise hold even if a future edit bypasses the wrapper.
//
// Default-deny: only the names below are exposed; anything else (including tools
// added by future updates) is blocked. The flag is off by default, so existing
// full-capability deployments are unchanged.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import path from "node:path";
import os from "node:os";

/** The ONLY tools exposed when safe mode is on: read/search + draft create/edit. */
export const SAFE_MODE_ALLOWED: ReadonlySet<string> = new Set<string>([
    // read / search
    "read_email", "search_emails", "get_thread_messages", "batch_read_emails",
    "get_drafts", "list_email_labels", "list_filters", "get_filter",
    "download_attachment",
    // draft create + edit (never sends)
    "draft_email", "update_draft",
]);

/**
 * Tools that must NEVER be exposed in safe mode. Not used for enforcement
 * (enforcement is the allowlist above); this is an explicit tripwire so a test
 * fails loudly if any of these ever lands on the allowlist.
 */
export const SAFE_MODE_FORBIDDEN: ReadonlySet<string> = new Set<string>([
    "send_email", "send_draft", "delete_draft",
    "batch_modify_emails", "batch_delete_emails", "modify_email", "delete_email",
    "archive_thread",
    "create_label", "update_label", "delete_label", "get_or_create_label",
    "create_filter", "delete_filter", "create_filter_from_template",
]);

/**
 * Whether safe mode is engaged. Normalizes the env value (trim + case-insensitive)
 * so a stray newline/quote from a templated or YAML-quoted env var can't silently
 * fail open. Accepts 1 / true / yes / on.
 */
export function isSafeModeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    const raw = env.GMAIL_SAFE_MODE;
    if (raw == null) return false;
    const v = raw.trim().toLowerCase();
    return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * Directory that safe-mode file writes are confined to. Two allowlisted "read"
 * tools (download_attachment, batch_read_emails) write to disk with a
 * caller-supplied path; in safe mode we force those writes here so a coerced
 * tool can't overwrite the server's own code or the token file and defeat safe
 * mode on the next restart.
 */
export const SAFE_MODE_DOWNLOAD_DIR = path.join(os.tmpdir(), "gmail-mcp-safe-downloads");

/**
 * Confine a caller-supplied file path to SAFE_MODE_DOWNLOAD_DIR, keeping only its
 * basename so absolute paths and `..` traversal cannot escape the sandbox.
 * Pure (no IO) — the caller creates the directory. Returns an absolute path.
 */
export function confineSafeModeWrite(requestedPath: string | undefined, fallbackName: string): string {
    const raw = requestedPath && requestedPath.trim() ? requestedPath : fallbackName;
    const base = path.basename(raw) || fallbackName;
    return path.join(SAFE_MODE_DOWNLOAD_DIR, base);
}

/**
 * Wrap server.registerTool so only allowlisted tools register. Call BEFORE any
 * tool is registered. The wrapper is installed as a non-writable own property so
 * it can't be reassigned away later in the process.
 */
export function installSafeMode(server: McpServer): void {
    const original = (server.registerTool as any).bind(server);
    const wrapped = (name: string, ...rest: any[]) => {
        if (!SAFE_MODE_ALLOWED.has(name)) {
            return; // blocked in safe mode — never registered
        }
        return original(name, ...rest);
    };
    Object.defineProperty(server, "registerTool", {
        value: wrapped,
        writable: false,
        configurable: false,
        enumerable: false,
    });
    console.error(
        `[gmail-mcp] GMAIL_SAFE_MODE ON — read + draft only. ` +
        `Exposing (${SAFE_MODE_ALLOWED.size}): ${[...SAFE_MODE_ALLOWED].sort().join(", ")}. ` +
        `Blocked: ${[...SAFE_MODE_FORBIDDEN].sort().join(", ")}.`
    );
}

/**
 * Defense-in-depth: after all tools are registered, verify the live registered
 * toolset contains ONLY allowlisted tools. Throws (hard boot failure) on any
 * non-allowlisted tool — catching anything that reached the registry via a path
 * other than the wrapped registerTool. Fails closed on a violation; if the SDK's
 * internal registry can't be read, logs a loud warning rather than silently
 * assuming safety.
 */
export function assertSafeModeToolset(server: McpServer): void {
    const registered = (server as any)._registeredTools;
    if (!registered || typeof registered !== "object") {
        console.error(
            `[gmail-mcp] WARNING: cannot read the SDK tool registry to verify safe mode ` +
            `(SDK internals may have changed). The registerTool wrapper is still active, ` +
            `but the post-registration invariant is unchecked.`
        );
        return;
    }
    const leaked = Object.keys(registered).filter((name) => !SAFE_MODE_ALLOWED.has(name));
    if (leaked.length > 0) {
        throw new Error(
            `[gmail-mcp] SAFE MODE INVARIANT VIOLATED: non-allowlisted tool(s) registered: ` +
            `${leaked.sort().join(", ")}. Refusing to start.`
        );
    }
}
