import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createEmailMessage, createEmailWithNodemailer } from '../dist/utl.js';

describe('createEmailMessage', () => {
    it('plain text email has correct headers', () => {
        const msg = createEmailMessage({
            to: ['a@b.com'],
            subject: 'Test Subject',
            body: 'Hello world',
        });
        assert.ok(msg.includes('Content-Type: text/plain'));
        assert.ok(msg.includes('To: a@b.com'));
        assert.ok(msg.includes('Subject: Test Subject'));
        assert.ok(msg.includes('Hello world'));
    });

    it('HTML multipart when htmlBody provided with text/html mimeType', () => {
        const msg = createEmailMessage({
            to: ['a@b.com'],
            subject: 'HTML Test',
            body: 'Plain version',
            htmlBody: '<p>HTML version</p>',
            mimeType: 'text/html',
        });
        assert.ok(msg.includes('multipart/alternative'));
        assert.ok(msg.includes('text/plain'));
        assert.ok(msg.includes('text/html'));
        assert.ok(msg.includes('Plain version'));
        assert.ok(msg.includes('<p>HTML version</p>'));
    });

    it('encodes non-ASCII subject with RFC 2047', () => {
        const msg = createEmailMessage({
            to: ['a@b.com'],
            subject: 'Héllo Wörld',
            body: 'test',
        });
        assert.ok(msg.includes('=?UTF-8?B?'));
    });

    it('includes In-Reply-To and References headers', () => {
        const msgId = '<abc123@gmail.com>';
        const msg = createEmailMessage({
            to: ['a@b.com'],
            subject: 'Reply',
            body: 'test',
            inReplyTo: msgId,
        });
        assert.ok(msg.includes(`In-Reply-To: ${msgId}`));
        assert.ok(msg.includes(`References: ${msgId}`));
    });
});

describe('createEmailWithNodemailer', () => {
    let tmpDir;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-utl-test-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('generates MIME string with attachment filename', async () => {
        const filePath = path.join(tmpDir, 'test.txt');
        fs.writeFileSync(filePath, 'attachment content');

        const raw = await createEmailWithNodemailer({
            to: ['a@b.com'],
            subject: 'With Attachment',
            body: 'See attached',
            attachments: [filePath],
        });
        assert.ok(raw.includes('test.txt'));
    });

    it('throws on missing attachment file', async () => {
        await assert.rejects(
            () => createEmailWithNodemailer({
                to: ['a@b.com'],
                subject: 'Missing',
                body: 'test',
                attachments: ['/nonexistent/file.txt'],
            }),
            { message: /File does not exist: \/nonexistent\/file.txt/ }
        );
    });
});
