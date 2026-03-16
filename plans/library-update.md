# Gmail MCP Server — Library Update Plan

**Status:** Ready
**Created:** 2026-03-16
**Goal:** Update all outdated dependencies, migrate to modern MCP SDK patterns, and add comprehensive test coverage before/after the refactor.

## Decision Log

- **Strategy B (McpServer + registerTool) over Strategy A:** Eliminates monolithic if/else dispatch, removes zod-to-json-schema, each tool self-contained. Phase 1 tests + splitting Phase 2 into sub-phases mitigates risk.
- **Split Phase 2 into 2a/2b:** SDK migration first (verify tests), then file split (verify tests again). Allows bisecting if something breaks.
- **Pin @types/node to 22.x:** Avoids Node 25 type churn (removed APIs, Buffer/ArrayBuffer strictness). LTS-aligned.
- **Tool annotations added during migration:** Setting readOnlyHint/destructiveHint on all 24 tools prevents MCP clients from treating read operations as destructive.
- **`account` parameter via `withAccount()` Zod helper:** Replaces the current `schemaWithAccount()` JSON mutation pattern. Each tool's inputSchema gets `account` as a native Zod field.

## Current State

| Dependency | Current (package.json) | Installed | Latest | Bump | Risk |
|---|---|---|---|---|---|
| @modelcontextprotocol/sdk | ^0.4.0 | 0.4.0 | 1.27.1 | MAJOR | **High** — complete API evolution |
| zod | ^3.22.4 | 3.24.1 | 4.3.6 | MAJOR | Medium — most patterns compatible |
| zod-to-json-schema | ^3.22.1 | 3.24.1 | 3.25.1 | minor | **Remove** — replaced by zod v4 native |
| nodemailer | ^7.0.3 | 7.0.3 | 8.0.2 | MAJOR | Low — only error code rename |
| open | ^10.0.0 | 10.1.0 | 11.0.0 | MAJOR | Low — only Node.js >=20 requirement |
| mime-types | ^3.0.1 | 3.0.1 | 3.0.2 | patch | None |
| mcp-evals | ^1.0.18 | 1.0.18 | 2.0.1 | MAJOR | Medium — EvalFunction.run signature changed |
| @types/mime-types | ^2.1.4 | 2.1.4 | 3.0.1 | MAJOR | None — aligns with mime-types 3.x |
| @types/nodemailer | ^6.4.17 | 6.4.17 | 7.0.11 | MAJOR | Low — aligns with nodemailer 8 |
| @types/node | ^20.10.5 | 20.17.10 | 22.x (LTS) | MAJOR | Low — pin to 22.x, skip 25 |
| typescript | ^5.3.3 | 5.7.2 | 5.9.3 | minor | Medium — ArrayBuffer strictness |
| googleapis | ^171.4.0 | 171.4.0 | 171.4.0 | — | Already latest |
| google-auth-library | ^10.6.1 | 10.6.1 | 10.6.1 | — | Already latest |
| html-to-text | ^9.0.5 | 9.0.5 | 9.0.5 | — | Already latest |

### Source Files
- `src/index.ts` — Main server (~1807 lines, monolithic tool registration + handler dispatch)
- `src/token-manager.ts` — Multi-account OAuth token management
- `src/utl.ts` — Email message composition (raw MIME + nodemailer)
- `src/filter-manager.ts` — Gmail filter CRUD
- `src/label-manager.ts` — Gmail label CRUD
- `src/evals/evals.ts` — MCP evaluation tests

### Critical Architecture Detail: `schemaWithAccount()`

At `src/index.ts:471-479`, a `schemaWithAccount()` function injects an `account` parameter into every tool's JSON schema AFTER `zodToJsonSchema()` converts it:

```typescript
function schemaWithAccount(schema: z.ZodTypeAny): Record<string, unknown> {
    const jsonSchema = zodToJsonSchema(schema) as Record<string, any>;
    if (!jsonSchema.properties) jsonSchema.properties = {};
    jsonSchema.properties.account = {
        type: 'string',
        description: "Account to use (e.g., 'work'). Optional if only one account.",
    };
    return jsonSchema;
}
```

All 24 tools call `schemaWithAccount(SomeSchema)`. The `account` param is NOT in any Zod schema — it's injected post-conversion. When migrating to `registerTool()`, this must be replaced with a Zod-native approach (see Phase 2a).

### Account Resolution Pattern (used by ALL handlers)

At `src/index.ts:661-665`, every tool call resolves account at the top of the `CallToolRequestSchema` handler:
```typescript
const requestedAccount = (args as any)?.account;
const accountId = resolveAccountId(accountsMap, requestedAccount);
const clients = accountsMap.get(accountId)!;
const gmail = clients.gmail;
const oauth2Client = clients.oauth2Client;
```

### Shared Handler: `handleEmailAction()`

At `src/index.ts:668`, an inner async function `handleEmailAction(action: "send" | "draft", validatedArgs: any)` is shared between `send_email` and `draft_email`. When splitting into tool modules, this must be extracted to a shared helper or kept in the `send.ts` module.

### Current Server Constructor (already has capabilities)

At `src/index.ts:492`:
```typescript
const server = new Server({
    name: "gmail",
    version: "1.0.0",
}, {
    capabilities: { tools: {} },
});
```

### Tool Count
Exactly **24 tools**: `send_email`, `draft_email`, `get_drafts`, `update_draft`, `delete_draft`, `send_draft`, `read_email`, `search_emails`, `modify_email`, `delete_email`, `list_email_labels`, `batch_modify_emails`, `batch_delete_emails`, `batch_read_emails`, `create_label`, `update_label`, `delete_label`, `get_or_create_label`, `create_filter`, `list_filters`, `get_filter`, `delete_filter`, `create_filter_from_template`, `download_attachment`, `get_thread_messages`, `archive_thread`

### Existing Tests
- `tests/token-manager.test.js` — 12 tests for token loading, account filtering, account resolution
- **No tests for:** index.ts (tool registration, tool handlers), utl.ts, filter-manager.ts, label-manager.ts

---

## Phase 1: Add Test Coverage (BEFORE upgrading)

Write tests against the **current** library versions so we have a regression safety net. Tests import from `dist/` (compiled JS), matching the existing pattern in `tests/token-manager.test.js`. Use `node:test` built-in runner.

**Pre-step:** Run `npm run build` to ensure `dist/` is up to date.

### 1.1 Test: `utl.ts` — Email Message Composition

**File:** `tests/utl.test.js`
**Imports:** `import { createEmailMessage, createEmailWithNodemailer } from '../dist/utl.js';`

`createEmailMessage(validatedArgs: any): string` — pure function, no mocking needed.
Construct `validatedArgs` as: `{ to: ['a@b.com'], subject: 'Test', body: 'Hello', cc: ['c@d.com'], bcc: ['e@f.com'], inReplyTo: '<msgid@gmail.com>', htmlBody: '<p>Hello</p>', mimeType: 'text/html' }`

- [ ] `createEmailMessage` — plain text: verify output contains `Content-Type: text/plain`, `To:`, `Subject:`
- [ ] `createEmailMessage` — HTML multipart: provide `htmlBody` + no explicit `mimeType`, verify `multipart/alternative` boundary + both text and HTML parts
- [ ] `createEmailMessage` — non-ASCII subject: use `'Héllo Wörld'`, verify `=?UTF-8?B?` encoding
- [ ] `createEmailMessage` — in-reply-to: provide `inReplyTo`, verify `In-Reply-To:` and `References:` headers present

`createEmailWithNodemailer(validatedArgs: any): Promise<string>` — uses real nodemailer + filesystem.
**Requires real temp files** for attachment tests (not mocks). Create with `fs.mkdtempSync` + `fs.writeFileSync`.

- [ ] `createEmailWithNodemailer` — generates MIME string containing attachment filename
- [ ] `createEmailWithNodemailer` — throws `Error('File does not exist: /nonexistent')` on missing file

### 1.2 Test: `label-manager.ts` — Gmail Label CRUD

**File:** `tests/label-manager.test.js`
**Imports:** `import { createLabel, updateLabel, deleteLabel, listLabels, findLabelByName, getOrCreateLabel } from '../dist/label-manager.js';`

All functions take `gmail` as first arg — mock it as an object with `users.labels.{create,update,delete,list,get}` methods that return `{ data: ... }`.

Return shape for `listLabels`: `{ all: Label[], system: Label[], user: Label[], count: { total, system, user } }`

- [ ] `createLabel` — success returns `response.data`
- [ ] `createLabel` — throws `'Label "X" already exists'` on duplicate
- [ ] `updateLabel` — success returns `response.data`
- [ ] `updateLabel` — throws on 404 (`error.code === 404`)
- [ ] `deleteLabel` — success returns `{ success: true, message: '...' }`
- [ ] `deleteLabel` — throws `'Cannot delete system label'` when `label.data.type === 'system'`
- [ ] `deleteLabel` — throws on 404
- [ ] `listLabels` — returns grouped structure with correct counts
- [ ] `findLabelByName` — case-insensitive match returns label; miss returns `null`
- [ ] `getOrCreateLabel` — returns existing label if found; creates new if not

### 1.3 Test: `filter-manager.ts` — Gmail Filter CRUD

**File:** `tests/filter-manager.test.js`
**Imports:** `import { createFilter, listFilters, getFilter, deleteFilter, filterTemplates } from '../dist/filter-manager.js';`

Mock `gmail` as object with `users.settings.filters.{create,list,get,delete}` methods.

- [ ] `createFilter` — success returns `response.data`
- [ ] `createFilter` — throws `'Invalid filter criteria'` on 400
- [ ] `listFilters` — returns `{ filters: [...], count: N }`
- [ ] `getFilter` — success returns filter; throws on 404
- [ ] `deleteFilter` — success returns `{ success: true, message: '...' }`; throws on 404
- [ ] `filterTemplates.fromSender` — returns `{ criteria: { from: email }, action: { addLabelIds, removeLabelIds } }`
- [ ] `filterTemplates.withSubject` — correct shape
- [ ] `filterTemplates.withAttachments` — correct shape
- [ ] `filterTemplates.largeEmails` — correct shape with `sizeComparison: 'larger'`
- [ ] `filterTemplates.containingText` — wraps text in quotes in query
- [ ] `filterTemplates.mailingList` — correct query format

### 1.4 Test: Tool Definition Smoke Tests

**File:** `tests/tools-smoke.test.js`

**Problem:** `index.ts` is a side-effectful executable — importing `dist/index.js` immediately calls `main()` → `loadCredentials()` → `process.exit(1)`. Cannot import directly.

**Solution:** Extract all Zod schemas to a new `src/schemas.ts` module. Export them as a named map. This is useful both for testing AND for Phase 2 migration (schemas can be imported by tool modules).

Steps:
- [ ] Create `src/schemas.ts` — move all 24 tool Zod schemas (e.g., `SearchEmailsSchema`, `SendEmailSchema`, etc.) into this file as named exports
- [ ] Update `src/index.ts` to import schemas from `./schemas.js`
- [ ] Rebuild (`npm run build`)
- [ ] Write smoke tests that import from `../dist/schemas.js`:
  - [ ] All 24 schema names are exported
  - [ ] Each schema produces a valid JSON Schema via `zodToJsonSchema()` (has `type: "object"` and `properties`)
  - [ ] Schema count matches 24

### 1.5 Test: Batch Processing Pure Functions (optional, high-value)

**Problem:** `batch_read_emails` (index.ts:886-1030) has complex retry logic, boundary extraction, and set-difference operations. These are the highest-risk logic in the codebase.

**Solution:** If `parseBatchResponse()` and `buildBatchRequest()` can be extracted as pure functions to a `src/batch-utils.ts` module, write unit tests for them. This is optional but high-value for Phase 2 safety.

- [ ] Extract batch helper functions if separable
- [ ] Test boundary parsing from response headers
- [ ] Test set-difference logic for missing ID detection

- [x] **Phase 1 Complete**

---

## Phase 2a: Upgrade MCP SDK + Migrate to McpServer (0.4.0 → 1.27.1)

Upgrade the SDK and convert all 24 tools to `registerTool()` in the existing `index.ts` monolith. Do NOT split files yet — keep the diff focused on SDK migration.

### 2a.1 Create `withAccount()` Zod Helper

Replace the current `schemaWithAccount()` JSON mutation with a Zod-native helper:

```typescript
// src/schemas.ts (or a new src/helpers.ts)
function withAccount<T extends z.ZodRawShape>(shape: T) {
  return {
    ...shape,
    account: z.string().optional().describe("Account to use (e.g., 'work'). Optional if only one account."),
  };
}
```

Every `registerTool()` call uses: `inputSchema: withAccount({ query: z.string(), ... })`

Delete `schemaWithAccount()` from `index.ts` (lines 471-479).

### 2a.2 SDK Migration Steps

- [ ] Update `package.json`: `@modelcontextprotocol/sdk` to `^1.27.1`
- [ ] Update `engines.node` from `>=14.0.0` to `>=20.0.0`
- [ ] Replace `Server` import with `McpServer` from `@modelcontextprotocol/sdk/server/mcp.js`
- [ ] Remove `CallToolRequestSchema`, `ListToolsRequestSchema` imports from `@modelcontextprotocol/sdk/types.js`
- [ ] Remove `zodToJsonSchema` import (keep `zod-to-json-schema` in package.json for now — Phase 3 removes it)
- [ ] Replace server constructor:
  ```typescript
  // Before (index.ts:492):
  const server = new Server({ name: "gmail", version: "1.0.0" }, { capabilities: { tools: {} } });
  // After:
  const server = new McpServer({ name: "gmail", version: "1.0.0" });
  ```
- [ ] Convert each of the 24 tools from `ListToolsRequestSchema` array + `CallToolRequestSchema` dispatch into individual `server.registerTool()` calls. Pattern:
  ```typescript
  server.registerTool("search_emails", {
    description: "Search Gmail messages",
    inputSchema: withAccount({
      query: z.string().describe("Gmail search query"),
      maxResults: z.number().min(1).max(500).default(10).describe("Max results"),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  }, async (args) => {
    const accountId = resolveAccountId(accountsMap, args.account);
    const { gmail } = accountsMap.get(accountId)!;
    // ... handler logic (same as current)
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });
  ```
- [ ] Remove manual `Schema.parse()` calls in handlers (McpServer validates automatically)
- [ ] Add tool annotations to ALL 24 tools:
  - **Read-only tools** (`search_emails`, `read_email`, `get_drafts`, `list_email_labels`, `list_filters`, `get_filter`, `batch_read_emails`, `get_thread_messages`, `download_attachment`): `{ readOnlyHint: true, destructiveHint: false }`
  - **Create/send tools** (`send_email`, `draft_email`, `update_draft`, `send_draft`, `create_label`, `update_label`, `get_or_create_label`, `create_filter`, `create_filter_from_template`): `{ readOnlyHint: false, destructiveHint: false }`
  - **Delete/modify tools** (`delete_email`, `delete_draft`, `modify_email`, `delete_label`, `delete_filter`, `batch_modify_emails`, `batch_delete_emails`, `archive_thread`): `{ readOnlyHint: false, destructiveHint: true }`
- [ ] Delete the `schemaWithAccount()` function (lines 471-479)
- [ ] Delete the `ListToolsRequestSchema` handler and the entire `CallToolRequestSchema` handler
- [ ] Extract `handleEmailAction()` (line 668) to module-level function or inline into `send_email`/`draft_email` handlers
- [ ] Keep `StdioServerTransport` (import path unchanged: `@modelcontextprotocol/sdk/server/stdio.js`)
- [ ] Run `tsc` to verify compilation
- [ ] Run `node --test tests/` — all Phase 1 tests pass

- [x] **Phase 2a Complete**

---

## Phase 2b: Split `index.ts` into Tool Modules

Now that `registerTool()` is working, split the monolith into focused modules.

### File Structure

```
src/
├── index.ts              # Server setup, transport, credentials, startup (~200 lines)
├── schemas.ts            # All 24 Zod schemas (created in Phase 1.4)
├── helpers.ts            # withAccount(), handleEmailAction(), account resolution
├── tools/
│   ├── search.ts         # search_emails, read_email, get_thread_messages (3 tools)
│   ├── send.ts           # send_email, draft_email, get_drafts, update_draft, delete_draft, send_draft (6 tools)
│   ├── manage.ts         # modify_email, delete_email, archive_thread (3 tools)
│   ├── batch.ts          # batch_modify_emails, batch_delete_emails, batch_read_emails (3 tools)
│   ├── labels.ts         # create_label, update_label, delete_label, get_or_create_label, list_email_labels (5 tools)
│   ├── filters.ts        # create_filter, list_filters, get_filter, delete_filter, create_filter_from_template (5 tools)
│   └── attachments.ts    # download_attachment (1 tool)
├── token-manager.ts      # (unchanged)
├── utl.ts                # (unchanged)
├── filter-manager.ts     # (unchanged)
└── label-manager.ts      # (unchanged)
```

### Pattern

Each tool file exports a registration function:
```typescript
// src/tools/search.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AccountClients } from '../token-manager.js';
import { withAccount } from '../helpers.js';
import { SearchEmailsSchema, ... } from '../schemas.js';

export function registerSearchTools(server: McpServer, accounts: Map<string, AccountClients>) {
  server.registerTool("search_emails", { ... }, async (args) => { ... });
  // ...
}
```

`index.ts` calls each:
```typescript
registerSearchTools(server, accountsMap);
registerSendTools(server, accountsMap);
// ...
```

### Steps

- [ ] Create `src/helpers.ts` with `withAccount()`, `handleEmailAction()`, account resolution helper
- [ ] Create each `src/tools/*.ts` file, moving tool registrations from `index.ts`
- [ ] Update `src/index.ts` to import and call `register*Tools()` functions
- [ ] Verify `index.ts` is now ~200 lines (setup + startup only)
- [ ] Run `tsc` to verify compilation
- [ ] Run `node --test tests/` — all tests pass
- [ ] Manual smoke test: `node dist/index.js` starts without errors

- [ ] **Phase 2b Complete**

---

## Phase 3: Upgrade Zod (3.x → 4.x)

### 3.1 Migration Steps

- [ ] Update `package.json`: `zod` to `^4.0.0`
- [ ] Remove `zod-to-json-schema` from dependencies
- [ ] Grep for any remaining `zodToJsonSchema(` calls — should be zero after Phase 2a. If found in test helpers or evals, replace with `z.toJSONSchema(schema)`
- [ ] Grep for `{ message:`, `invalid_type_error:`, `required_error:` in schema definitions — these are deprecated in v4, replace with `{ error: ... }` param
- [ ] Audit these 5 specific `.default().optional()` fields:
  - `BatchModifyEmailsSchema.batchSize`: `z.number().optional().default(50)` — v4: missing → `50` (correct, matches handler fallback `|| 50`)
  - `BatchDeleteEmailsSchema.batchSize`: `z.number().optional().default(50)` — same as above
  - `BatchReadEmailsSchema.maxBodyLength`: `z.coerce.number().optional().default(5000)` — v4: missing → `5000` (correct)
  - `SendEmailSchema.mimeType`: `z.enum([...]).optional().default('text/plain')` — v4: missing → `'text/plain'` (correct)
  - `UpdateDraftSchema.mimeType`: same as above
  - **Verdict:** All 5 produce MORE correct behavior in v4 (defaults apply). Remove redundant `|| 50` / `|| 'text/plain'` fallbacks in handlers.
- [ ] Run `tsc` + `node --test tests/`

### 3.2 No Changes Needed For
- `z.object()`, `z.string()`, `z.number()`, `z.boolean()`, `z.array()`, `z.enum()` — all compatible
- `.optional()`, `.describe()` — unchanged
- `.min()`, `.max()`, `.default()` — unchanged (except interaction with `.optional()` above)

### 3.3 Optional Cleanup (non-blocking)
- Replace `z.string().email()` → `z.email()` (top-level in v4)
- Replace `.strict()` → `z.strictObject()` if used

- [x] **Phase 3 Complete**

---

## Phase 4: Upgrade Remaining Dependencies

All low-risk, done in a single batch.

- [ ] `nodemailer`: `^7.0.3` → `^8.0.0`
  - Only breaking change: error code `'NoAuth'` → `'ENOAUTH'` (not used in codebase)
  - Verify `streamTransport: true, buffer: true` still works (Phase 1 utl.ts tests catch this)
- [ ] `open`: `^10.0.0` → `^11.0.0`
  - Only breaking change: requires Node.js >=20 (already bumped in Phase 2a)
- [ ] `mime-types`: `^3.0.1` → `^3.0.2` (patch)
- [ ] `@types/mime-types`: `^2.1.4` → `^3.0.1`
- [ ] `@types/nodemailer`: `^6.4.17` → `^7.0.11`
- [ ] `@types/node`: `^20.10.5` → `^22.0.0` (pin to LTS, not 25.x — avoids unnecessary churn)
- [ ] `typescript`: `^5.3.3` → `^5.9.0`
- [ ] `@types/html-to-text`: keep at `^9.0.4` (already latest)
- [ ] Run `tsc` + `node --test tests/` after batch update

- [x] **Phase 4 Complete**

---

## Phase 5: Upgrade mcp-evals (1.x → 2.x)

Separate phase because it requires code changes.

- [ ] Update `package.json`: `mcp-evals` to `^2.0.0`
- [ ] Check if `EvalConfig` interface still has a `model` field in v2 — the current code has `const config: EvalConfig = { model: openai("gpt-4"), ... }` at module level (evals.ts:89). If `model` was removed from `EvalConfig` in v2 (now passed per-eval), delete this field.
- [ ] Update `src/evals/evals.ts` — each eval's `run` function signature:
  ```typescript
  // Before (v1):
  run: async () => {
      const result = await grade(openai("gpt-4"), "...");
      return JSON.parse(result);
  }

  // After (v2):
  run: async (model: LanguageModel) => {
      const result = await grade(model, "...");
      return JSON.parse(result);
  }
  ```
- [ ] Verify `LanguageModel` type — likely re-exported from `mcp-evals` or import from `ai` package. Current code already imports `openai` from `@ai-sdk/openai`.
- [ ] Run evals to verify

- [ ] **Phase 5 Complete**

---

## Phase 6: Final Verification

- [ ] `npm run build` — clean compile with zero warnings
- [ ] `node --test tests/` — all tests pass
- [ ] Manual smoke test: start server via `node dist/index.js`, verify tool listing works via MCP Inspector (`npx @modelcontextprotocol/inspector`)
- [ ] Verify both `gmail-personal` and `gmail-product-scout` MCP configs still work in Claude Code (restart Claude Code, check `/mcp`)
- [ ] Update `package.json` version (bump to 2.0.0 — major version for SDK migration)
- [ ] Run `/check-execution` against this plan

- [ ] **Phase 6 Complete**

---

## Execution Order

```
Phase 1 (Tests) → Phase 2a (SDK migration) → Phase 2b (File split) → Phase 3 (Zod) → Phase 4 (Batch deps) → Phase 5 (mcp-evals) → Phase 6 (Verify)
```

Phases 3 and 4 can potentially be combined since they're lower risk, but keeping them separate makes bisecting easier if something breaks.

## Context Budget Estimate (1M token context)

| Phase | Complexity | Context % (of 1M) |
|---|---|---|
| Phase 1 (Tests) | Medium — 4 test files, ~40 test cases, schema extraction | ~8% |
| Phase 2a (SDK migration) | Heavy — rewrite all 24 tool registrations + account pattern | ~12% |
| Phase 2b (File split) | Medium — move code into 7 tool modules | ~6% |
| Phase 3 (Zod v4) | Light — package bump + 5-field audit | ~3% |
| Phase 4 (Batch deps) | Trivial — package.json + tsc | ~1% |
| Phase 5 (mcp-evals) | Light — one file change | ~2% |
| Phase 6 (Verify) | Trivial — checklist | ~1% |
| **Total** | | **~33%** |

**Session plan: Single session.** All phases fit comfortably within 1M context (~33% total). Execute sequentially: Phase 1 → 2a → 2b → 3 → 4 → 5 → 6.

## Deliberate Omissions

- **No Streamable HTTP transport**: Plan only migrates stdio transport. HTTP/SSE transport is a future concern.
- **No tool description improvements**: Existing descriptions are kept as-is. Could be improved later per MCP best practices.
- **No large-content output_path pattern**: Some tools return large responses — optimizing with file output is a future enhancement.
- **No layered tool pattern**: 24 tools is manageable. Block's layered discovery pattern is for 100+ endpoint APIs.

## Changelog

### Session 1 — 2026-03-16
- Completed: Phase 1 (test coverage), Phase 2a (SDK migration to McpServer + registerTool)
- Key decisions:
  - 25 schemas (not 24) — send_email/draft_email share SendEmailSchema, plus SendDraftSchema is separate
  - Used `.shape` property from Zod objects + `withAccount()` helper to pass raw shapes to `registerTool()`
  - Extracted `handleEmailAction()` and `processBatches()` to module-level functions (outside the request handler)
  - `type: "text" as const` needed in return values for TypeScript literal type inference
  - Phase 1.5 (batch utils extraction) skipped as optional
- Tests: 71 passing (14 original + 6 utl + 10 label-manager + 15 filter-manager + 26 schema smoke)
- Build: clean
- Files changed: src/index.ts (major rewrite), src/schemas.ts (new), tests/utl.test.js (new), tests/label-manager.test.js (new), tests/filter-manager.test.js (new), tests/tools-smoke.test.js (new)
- Next: Phase 2b (file split), Phase 3 (Zod v4), Phase 4 (batch deps), Phase 5 (mcp-evals), Phase 6 (verify)

### Session 1 (continued) — 2026-03-16
- Completed: Phase 3 (Zod v4), Phase 4 (batch dependencies)
- Skipped for now: Phase 2b (file split) — purely organizational, no dependency on other phases
- Key decisions:
  - Excluded `src/evals/` from tsconfig because `mcp-evals@1.x` depends on `LanguageModelV1` which conflicts with the newer `@ai-sdk/openai` that ships `LanguageModelV3`. Will fix in Phase 5.
  - Added `@ai-sdk/openai` as direct dependency (was transitive via mcp-evals before Zod v4 broke the chain)
  - Replaced `zod-to-json-schema` with Zod v4 native `z.toJSONSchema()` in smoke tests
  - `zod-to-json-schema` removed from dependencies entirely
- Dependencies upgraded: zod (3.24→4.3), nodemailer (7.0→8.0), open (10.1→11.0), mime-types (3.0.1→3.0.2), @types/mime-types (2.1→3.0), @types/nodemailer (6.4→7.0), @types/node (20→22), typescript (5.7→5.9)
- Tests: 71 passing
- Build: clean (evals excluded)
- Next: Phase 5 (mcp-evals upgrade), Phase 2b (optional file split), Phase 6 (verify)

### Session 1 (bug fix) — 2026-03-16
- Fixed: `batch_read_emails` — cross-realm `Headers` object from `google-auth-library` caused `instanceof Headers` to return `false`, falling through to bracket access which doesn't work on `Headers` objects. Fix: duck-type check `typeof hdrs?.get === 'function'` instead of `instanceof`.
- Verified: live API call successfully extracts boundary and returns batch results
- Tests: 71 passing, build clean
