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
    effectiveSafeModeAllowed,
    installSafeMode,
    assertSafeModeToolset,
    confineSafeModeWrite,
} from '../dist/safe-mode.js';

const EXPECTED_BASE = [
    'batch_read_emails', 'download_attachment', 'draft_email', 'get_drafts', 'get_filter',
    'get_thread_messages', 'list_email_labels', 'list_filters', 'read_email',
    'search_emails', 'update_draft',
].sort();
const EXPECTED_ARCHIVE = [...EXPECTED_BASE, 'archive_emails'].sort();
const SAFE_ENV = { GMAIL_SAFE_MODE: '1' };
const ARCHIVE_ENV = { GMAIL_SAFE_MODE: '1', GMAIL_SAFE_MODE_ALLOW_ARCHIVE: '1' };

function fakeServer() {
    const registered = [];
    return {
        registered,
        registerTool: (name) => { registered.push(name); return { name }; },
    };
}

describe('GMAIL_SAFE_MODE base policy', () => {
    it('exposes exactly the 11 read + draft tools by default', () => {
        assert.equal(SAFE_MODE_ALLOWED.size, 11);
        assert.deepEqual([...SAFE_MODE_ALLOWED].sort(), EXPECTED_BASE);
        assert.deepEqual([...effectiveSafeModeAllowed(SAFE_ENV)].sort(), EXPECTED_BASE);
    });

    it('does not allow any broad mutation in base or archive policy', () => {
        for (const name of SAFE_MODE_FORBIDDEN) {
            assert.ok(!SAFE_MODE_ALLOWED.has(name), `${name} must not be base-allowlisted`);
            assert.ok(!effectiveSafeModeAllowed(ARCHIVE_ENV).has(name), `${name} must not be archive-allowlisted`);
        }
        for (const name of ['send_email', 'send_draft', 'delete_email', 'batch_delete_emails', 'delete_draft', 'modify_email', 'batch_modify_emails']) {
            assert.ok(!effectiveSafeModeAllowed(ARCHIVE_ENV).has(name), `${name} must not be exposed`);
        }
    });
});

describe('archive-only opt-in policy', () => {
    it('adds exactly archive_emails in safe mode', () => {
        assert.deepEqual([...effectiveSafeModeAllowed(ARCHIVE_ENV)].sort(), EXPECTED_ARCHIVE);
        assert.deepEqual([...effectiveSafeModeAllowed({ ...SAFE_ENV, GMAIL_SAFE_MODE_ALLOW_ARCHIVE: '"1"' })].sort(), EXPECTED_ARCHIVE);
        assert.ok(!effectiveSafeModeAllowed(ARCHIVE_ENV).has('archive_thread'));
    });

    it('keeps archive disabled when unset or explicitly false', () => {
        for (const value of [undefined, '', '0', 'false', 'no', 'off']) {
            const env = { ...SAFE_ENV };
            if (value !== undefined) env.GMAIL_SAFE_MODE_ALLOW_ARCHIVE = value;
            assert.deepEqual([...effectiveSafeModeAllowed(env)].sort(), EXPECTED_BASE);
        }
    });

    it('rejects invalid policy values and archive opt-in without safe mode', () => {
        assert.throws(() => effectiveSafeModeAllowed({ ...SAFE_ENV, GMAIL_SAFE_MODE_ALLOW_ARCHIVE: 'maybe' }), /Invalid GMAIL_SAFE_MODE_ALLOW_ARCHIVE/);
        assert.throws(() => effectiveSafeModeAllowed({ GMAIL_SAFE_MODE_ALLOW_ARCHIVE: '1' }), /requires GMAIL_SAFE_MODE=1/);
    });
});

describe('GMAIL_SAFE_MODE flag parsing', () => {
    it('is on for truthy values, tolerating whitespace/case', () => {
        for (const value of ['1', ' 1 ', '1\n', 'true', 'TRUE', 'yes', 'on', '  on\t', '"1"', "'on'"]) {
            assert.equal(isSafeModeEnabled({ GMAIL_SAFE_MODE: value }), true, `${value} should enable safe mode`);
        }
    });

    it('is off when unset or falsey', () => {
        for (const env of [{}, { GMAIL_SAFE_MODE: '' }, { GMAIL_SAFE_MODE: '0' }, { GMAIL_SAFE_MODE: 'false' }, { GMAIL_SAFE_MODE: 'no' }]) {
            assert.equal(isSafeModeEnabled(env), false, `${JSON.stringify(env)} should not enable safe mode`);
        }
    });
});

describe('installSafeMode wrapper and invariant', () => {
    it('registers only the base safe-mode tools without the opt-in', () => {
        const server = fakeServer();
        const allowed = installSafeMode(server, SAFE_ENV);
        for (const name of ['read_email', 'draft_email', 'archive_emails', 'send_email', 'delete_email']) {
            server.registerTool(name, {}, async () => ({}));
        }
        assert.deepEqual(server.registered.sort(), ['draft_email', 'read_email']);
        assert.deepEqual([...allowed].sort(), EXPECTED_BASE);
    });

    it('registers archive_emails only with the opt-in', () => {
        const server = fakeServer();
        const allowed = installSafeMode(server, ARCHIVE_ENV);
        for (const name of ['read_email', 'archive_emails', 'archive_thread', 'modify_email', 'send_email']) {
            server.registerTool(name, {}, async () => ({}));
        }
        assert.deepEqual(server.registered.sort(), ['archive_emails', 'read_email']);
        assert.deepEqual([...allowed].sort(), EXPECTED_ARCHIVE);
    });

    it('installs registerTool as a non-writable property', () => {
        const server = fakeServer();
        installSafeMode(server, SAFE_ENV);
        assert.throws(() => { 'use strict'; server.registerTool = () => 'tampered'; });
    });

    it('fails closed on a leaked tool or an unreadable registry', () => {
        const allowed = effectiveSafeModeAllowed(ARCHIVE_ENV);
        assert.doesNotThrow(() => assertSafeModeToolset({ _registeredTools: { read_email: {}, archive_emails: {} } }, allowed));
        assert.throws(() => assertSafeModeToolset({ _registeredTools: { read_email: {}, modify_email: {} } }, allowed), /INVARIANT VIOLATED[\s\S]*modify_email/);
        assert.throws(() => assertSafeModeToolset({}, allowed), /Cannot inspect SDK tool registry/);
    });
});

describe('confineSafeModeWrite sandbox', () => {
    it('strips absolute paths and traversal, confining to the sandbox dir', () => {
        const absolute = confineSafeModeWrite('/home/chris/gmail-mcp-server/dist/index.js', 'x');
        assert.equal(path.dirname(absolute), SAFE_MODE_DOWNLOAD_DIR);
        assert.equal(path.basename(absolute), 'index.js');
        const traversal = confineSafeModeWrite('../../../home/chris/.google-mcp/gmail-tokens.json', 'x');
        assert.equal(path.dirname(traversal), SAFE_MODE_DOWNLOAD_DIR);
        assert.equal(path.basename(traversal), 'gmail-tokens.json');
    });
});

describe('GMAIL_SAFE_MODE end-to-end (real MCP SDK)', () => {
    it('lists only the archive-only policy over the wire', async () => {
        const server = new McpServer({ name: 'gmail-safe-mode-test', version: '0.0.0' });
        const allowed = installSafeMode(server, ARCHIVE_ENV);
        for (const name of ['read_email', 'draft_email', 'archive_emails', 'archive_thread', 'send_email', 'modify_email', 'delete_email']) {
            server.registerTool(name, { description: name, inputSchema: {} }, async () => ({ content: [{ type: 'text', text: 'ok' }] }));
        }
        assert.doesNotThrow(() => assertSafeModeToolset(server, allowed));
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: 'test-client', version: '0.0.0' });
        await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
        try {
            const { tools } = await client.listTools();
            assert.deepEqual(tools.map((tool) => tool.name).sort(), ['archive_emails', 'draft_email', 'read_email']);
        } finally {
            await client.close();
            await server.close();
        }
    });
});
