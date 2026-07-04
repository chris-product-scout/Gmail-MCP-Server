import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
    SAFE_MODE_ALLOWED,
    SAFE_MODE_FORBIDDEN,
    SAFE_MODE_DOWNLOAD_DIR,
    isSafeModeEnabled,
    installSafeMode,
    assertSafeModeToolset,
    confineSafeModeWrite,
} from '../dist/safe-mode.js';

// The exact read + draft-only surface Hermes (and any untrusted deployment) may see.
const EXPECTED_ALLOWED = [
    'batch_read_emails', 'download_attachment', 'draft_email', 'get_drafts', 'get_filter',
    'get_thread_messages', 'list_email_labels', 'list_filters', 'read_email',
    'search_emails', 'update_draft',
].sort();

describe('GMAIL_SAFE_MODE allowlist', () => {
    it('exposes exactly the 11 read + draft tools', () => {
        assert.equal(SAFE_MODE_ALLOWED.size, 11);
        assert.deepEqual([...SAFE_MODE_ALLOWED].sort(), EXPECTED_ALLOWED);
    });

    it('never allowlists a send/delete/modify/label/filter tool', () => {
        for (const name of SAFE_MODE_FORBIDDEN) {
            assert.ok(!SAFE_MODE_ALLOWED.has(name), `${name} must never be allowlisted in safe mode`);
        }
        // Explicit belt-and-suspenders on the irreversible ones.
        for (const name of ['send_email', 'send_draft', 'delete_email', 'batch_delete_emails', 'delete_draft']) {
            assert.ok(!SAFE_MODE_ALLOWED.has(name));
        }
    });
});

describe('GMAIL_SAFE_MODE flag parsing', () => {
    it('is on for truthy values, tolerating whitespace/case (no silent fail-open)', () => {
        for (const v of ['1', ' 1 ', '1\n', 'true', 'TRUE', 'yes', 'on', '  on\t']) {
            assert.equal(isSafeModeEnabled({ GMAIL_SAFE_MODE: v }), true, `"${v}" should enable safe mode`);
        }
    });

    it('is off when unset or falsey', () => {
        for (const env of [{}, { GMAIL_SAFE_MODE: '' }, { GMAIL_SAFE_MODE: '0' }, { GMAIL_SAFE_MODE: 'false' }, { GMAIL_SAFE_MODE: 'no' }]) {
            assert.equal(isSafeModeEnabled(env), false, `${JSON.stringify(env)} should NOT enable safe mode`);
        }
    });
});

describe('installSafeMode wrapper', () => {
    it('registers allowlisted tools and silently drops the rest', () => {
        const registered = [];
        const fakeServer = { registerTool: (name) => { registered.push(name); return { name }; } };
        installSafeMode(fakeServer);
        for (const n of ['read_email', 'draft_email', 'send_email', 'delete_email', 'batch_delete_emails', 'archive_thread']) {
            fakeServer.registerTool(n, {}, async () => ({}));
        }
        assert.deepEqual(registered.sort(), ['draft_email', 'read_email']);
    });

    it('installs registerTool as a non-writable property (cannot be reassigned away)', () => {
        const fakeServer = { registerTool: () => {} };
        installSafeMode(fakeServer);
        assert.throws(() => { 'use strict'; fakeServer.registerTool = () => 'tampered'; });
    });
});

describe('assertSafeModeToolset invariant', () => {
    it('passes when only allowlisted tools are registered', () => {
        const okServer = { _registeredTools: { read_email: {}, draft_email: {}, update_draft: {} } };
        assert.doesNotThrow(() => assertSafeModeToolset(okServer));
    });

    it('throws (fails closed) if a non-allowlisted tool leaked into the registry', () => {
        const leaky = { _registeredTools: { read_email: {}, send_email: {} } };
        assert.throws(() => assertSafeModeToolset(leaky), /INVARIANT VIOLATED[\s\S]*send_email/);
    });
});

describe('confineSafeModeWrite sandbox', () => {
    it('strips absolute paths and traversal, confining to the sandbox dir', () => {
        const a = confineSafeModeWrite('/home/chris/gmail-mcp-server/dist/index.js', 'x');
        assert.equal(path.dirname(a), SAFE_MODE_DOWNLOAD_DIR);
        assert.equal(path.basename(a), 'index.js');

        const b = confineSafeModeWrite('../../../home/chris/.google-mcp/gmail-tokens.json', 'x');
        assert.equal(path.dirname(b), SAFE_MODE_DOWNLOAD_DIR);
        assert.equal(path.basename(b), 'gmail-tokens.json');

        const c = confineSafeModeWrite(undefined, 'fallback.bin');
        assert.equal(c, path.join(SAFE_MODE_DOWNLOAD_DIR, 'fallback.bin'));
    });
});

describe('GMAIL_SAFE_MODE end-to-end (real MCP SDK)', () => {
    it('a safe-mode server lists ONLY allowlisted tools over the wire', async () => {
        const server = new McpServer({ name: 'gmail-safe-mode-test', version: '0.0.0' });
        installSafeMode(server);

        // Register a representative mix through the (now-wrapped) registerTool.
        const registerNames = [
            'read_email', 'draft_email', 'update_draft',        // allowed
            'send_email', 'send_draft', 'delete_email', 'batch_delete_emails', 'archive_thread', // blocked
        ];
        for (const n of registerNames) {
            server.registerTool(n, { description: n, inputSchema: {} }, async () => ({ content: [{ type: 'text', text: 'ok' }] }));
        }

        // Invariant must pass (nothing blocked leaked into the registry).
        assert.doesNotThrow(() => assertSafeModeToolset(server));

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: 'test-client', version: '0.0.0' });
        await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

        try {
            const { tools } = await client.listTools();
            const exposed = tools.map((t) => t.name).sort();
            assert.deepEqual(exposed, ['draft_email', 'read_email', 'update_draft']);
            for (const forbidden of ['send_email', 'send_draft', 'delete_email', 'batch_delete_emails', 'archive_thread']) {
                assert.ok(!exposed.includes(forbidden), `${forbidden} must not be exposed`);
            }
        } finally {
            await client.close();
            await server.close();
        }
    });
});
