import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadMultiAccountTokens, filterByAllowedAccounts, resolveAccountId } from '../dist/token-manager.js';

// Minimal mock AccountClients for testing filter/resolve (no real OAuth)
function mockAccounts(names) {
    const map = new Map();
    for (const name of names) {
        map.set(name, { oauth2Client: {}, gmail: {} });
    }
    return map;
}

describe('loadMultiAccountTokens', () => {
    let tmpDir;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-test-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('detects flat format and wraps as default', () => {
        const flatToken = { refresh_token: 'rt_123', access_token: 'at_456', token_type: 'Bearer' };
        const tokenPath = path.join(tmpDir, 'flat.json');
        fs.writeFileSync(tokenPath, JSON.stringify(flatToken));

        const result = loadMultiAccountTokens(tokenPath);
        assert.deepEqual(Object.keys(result), ['default']);
        assert.equal(result.default.refresh_token, 'rt_123');
    });

    it('loads multi-account format as-is', () => {
        const multiToken = {
            work: { refresh_token: 'rt_work', token_type: 'Bearer' },
            personal: { refresh_token: 'rt_personal', token_type: 'Bearer' },
        };
        const tokenPath = path.join(tmpDir, 'multi.json');
        fs.writeFileSync(tokenPath, JSON.stringify(multiToken));

        const result = loadMultiAccountTokens(tokenPath);
        assert.deepEqual(Object.keys(result).sort(), ['personal', 'work']);
        assert.equal(result.work.refresh_token, 'rt_work');
        assert.equal(result.personal.refresh_token, 'rt_personal');
    });

    it('detects access_token-only flat format', () => {
        const flatToken = { access_token: 'at_only', token_type: 'Bearer' };
        const tokenPath = path.join(tmpDir, 'access-only.json');
        fs.writeFileSync(tokenPath, JSON.stringify(flatToken));

        const result = loadMultiAccountTokens(tokenPath);
        assert.deepEqual(Object.keys(result), ['default']);
        assert.equal(result.default.access_token, 'at_only');
    });
});

describe('filterByAllowedAccounts', () => {
    const originalEnv = process.env.ALLOWED_ACCOUNTS;

    afterEach(() => {
        if (originalEnv === undefined) {
            delete process.env.ALLOWED_ACCOUNTS;
        } else {
            process.env.ALLOWED_ACCOUNTS = originalEnv;
        }
    });

    it('returns all accounts when no filter set', () => {
        delete process.env.ALLOWED_ACCOUNTS;
        const accounts = mockAccounts(['work', 'personal']);
        const filtered = filterByAllowedAccounts(accounts);
        assert.equal(filtered.size, 2);
    });

    it('filters to single account', () => {
        process.env.ALLOWED_ACCOUNTS = 'work';
        const accounts = mockAccounts(['work', 'personal']);
        const filtered = filterByAllowedAccounts(accounts);
        assert.equal(filtered.size, 1);
        assert.ok(filtered.has('work'));
    });

    it('filters to multiple accounts', () => {
        process.env.ALLOWED_ACCOUNTS = 'work,personal';
        const accounts = mockAccounts(['work', 'personal', 'other']);
        const filtered = filterByAllowedAccounts(accounts);
        assert.equal(filtered.size, 2);
        assert.ok(filtered.has('work'));
        assert.ok(filtered.has('personal'));
    });

    it('handles case-insensitive matching', () => {
        process.env.ALLOWED_ACCOUNTS = 'Work,PERSONAL';
        const accounts = mockAccounts(['work', 'personal']);
        const filtered = filterByAllowedAccounts(accounts);
        assert.equal(filtered.size, 2);
    });

    it('warns on missing account without failing', () => {
        process.env.ALLOWED_ACCOUNTS = 'work,nonexistent';
        const accounts = mockAccounts(['work', 'personal']);
        const filtered = filterByAllowedAccounts(accounts);
        assert.equal(filtered.size, 1);
        assert.ok(filtered.has('work'));
    });
});

describe('resolveAccountId', () => {
    it('auto-selects single account without param', () => {
        const accounts = mockAccounts(['work']);
        assert.equal(resolveAccountId(accounts), 'work');
    });

    it('throws for empty accounts map', () => {
        const accounts = mockAccounts([]);
        assert.throws(() => resolveAccountId(accounts), /No authenticated accounts/);
    });

    it('throws for multiple accounts without param', () => {
        const accounts = mockAccounts(['work', 'personal']);
        assert.throws(() => resolveAccountId(accounts), /must specify.*account/i);
    });

    it('returns requested account when valid', () => {
        const accounts = mockAccounts(['work', 'personal']);
        assert.equal(resolveAccountId(accounts, 'work'), 'work');
    });

    it('normalizes account to lowercase', () => {
        const accounts = mockAccounts(['work', 'personal']);
        assert.equal(resolveAccountId(accounts, 'Work'), 'work');
    });

    it('throws for invalid account with available list', () => {
        const accounts = mockAccounts(['work', 'personal']);
        assert.throws(
            () => resolveAccountId(accounts, 'nonexistent'),
            /nonexistent.*not found.*Available.*work.*personal/i
        );
    });
});
