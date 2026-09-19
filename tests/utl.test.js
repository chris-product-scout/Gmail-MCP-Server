import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createEmailMessage, createEmailWithNodemailer, formatAddressList, parseAddressList } from '../dist/utl.js';

/** Decode RFC 2047 Q-encoded words in a header line back to their original text. */
function decodeQWords(line) {
    // RFC 2047 s6.2: whitespace separating two adjacent encoded words is not part of
    // the text and must be removed before decoding, or a split name gains a space.
    return line
        .replace(/(\?=)\s+(=\?)/g, '$1$2')
        .replace(/=\?UTF-8\?Q\?([^?]*)\?=/gi, (_, body) => {
        const bytes = body.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (_m, hex) =>
            String.fromCharCode(parseInt(hex, 16)));
        return Buffer.from(bytes, 'binary').toString('utf8');
    });
}

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

describe('display names in recipient headers', () => {
    it('keeps a display name the caller passed', () => {
        const msg = createEmailMessage({
            to: ['Andrea Wan <awan@example.com>'],
            cc: ['Karan Kashyap <karan@example.com>'],
            subject: 'Next steps',
            body: 'Hi Andrea,',
        });
        assert.ok(msg.includes('To: "Andrea Wan" <awan@example.com>'));
        assert.ok(msg.includes('Cc: "Karan Kashyap" <karan@example.com>'));
    });

    it('leaves a bare address bare', () => {
        const msg = createEmailMessage({ to: ['a@b.com', 'c@d.com'], subject: 'S', body: 'B' });
        assert.ok(msg.includes('To: a@b.com, c@d.com'));
    });

    it('RFC 2047 encodes a non-ASCII display name, and it decodes back', () => {
        // The nodemailer (attachment) path has always done this; the plain builder
        // used to emit raw UTF-8 in the header. Both now use Q encoding.
        const name = 'Jos\u00e9 Garc\u00eda';
        const msg = createEmailMessage({ to: [`${name} <jose@example.com>`], subject: 'S', body: 'B' });
        const toLine = msg.split('\r\n').find(l => l.startsWith('To: '));
        assert.match(toLine, /^To: =\?UTF-8\?Q\?\S+\?= <jose@example\.com>$/);
        assert.equal(decodeQWords(toLine), `To: ${name} <jose@example.com>`);
    });

    it('escapes a quote inside a display name', () => {
        const out = formatAddressList(['"Andrea \\"AJ\\" Wan" <awan@example.com>']);
        assert.equal(out, '"Andrea \\"AJ\\" Wan" <awan@example.com>');
    });
});

describe('parseAddressList', () => {
    it('keeps a quoted name containing a comma as one recipient', () => {
        // A naive header.split(',') turned this into two malformed entries.
        const out = parseAddressList('"Wan, Andrea" <awan@example.com>, karan@example.com', 'me@example.com');
        assert.deepEqual(out, ['"Wan, Andrea" <awan@example.com>', 'karan@example.com']);
    });

    it('excludes the given address, matching on the address not the whole entry', () => {
        const out = parseAddressList('Me <me@example.com>, Andrea Wan <awan@example.com>', 'me@example.com');
        assert.deepEqual(out, ['"Andrea Wan" <awan@example.com>']);
    });

    it('keeps every recipient when the exclude address is empty', () => {
        // The old substring filter dropped EVERYONE here, since ''.includes('') is true.
        const out = parseAddressList('a@b.com, Andrea Wan <awan@example.com>', '');
        assert.deepEqual(out, ['a@b.com', '"Andrea Wan" <awan@example.com>']);
    });
});


describe('a recipient with no address fails loudly', () => {
    // Filtering the bad entry out would send to everyone else and tell nobody.
    it('formatAddressList throws and names the offending entry', () => {
        assert.throws(
            () => formatAddressList(['Andrea Wan', 'karan@example.com']),
            /Recipient has no email address: "Andrea Wan"/
        );
    });

    it('parseAddressList throws on the reply path too', () => {
        assert.throws(
            () => parseAddressList('Andrea Wan, karan@example.com', 'me@example.com'),
            /Recipient has no email address/
        );
    });

    it('an empty list is not an error', () => {
        assert.equal(formatAddressList([]), '');
    });
});

describe('long and pre-encoded names', () => {
    it('leaves an already-encoded word unquoted', () => {
        // RFC 2047 s5 forbids an encoded word inside a quoted-string; a client that
        // sees one quoted renders the raw =?UTF-8?...?= instead of the name.
        const out = parseAddressList('=?UTF-8?Q?Jos=C3=A9?= <jose@example.com>', 'me@example.com');
        assert.deepEqual(out, ['=?UTF-8?Q?Jos=C3=A9?= <jose@example.com>']);
    });

    it('splits a long non-ASCII name so no encoded word exceeds 75 chars', () => {
        const name = 'Zo\u00eb M\u00fcller-Sch\u00e4fer von der Heydenreich Gr\u00fcnewald';
        assert.ok(Buffer.byteLength(name) > 45, 'fixture must exceed the single-word limit');
        const out = formatAddressList([name + ' <zoe@example.com>']);
        const words = out.match(/=\?UTF-8\?Q\?[^?]*\?=/g);
        assert.ok(words.length > 1, 'expected the name to split into multiple encoded words');
        for (const w of words) assert.ok(w.length <= 75, `encoded word too long: ${w.length}`);
        // Splitting must be lossless: the words rejoin to exactly the original name.
        // Verified against Gmail on 2026-09-19 — a draft carrying this exact split pair
        // came back from the API as one correctly-joined name. Note that Python's
        // email.headerregistry does NOT apply RFC 2047 s6.2 and reports a spurious
        // space here; that is a quirk of that parser, not a defect in this output.
        assert.equal(decodeQWords(out), `${name} <zoe@example.com>`);
    });

    it('folds a long recipient list under the 78-char soft limit', () => {
        // 15 named recipients push a single To: line past RFC 5322's 998-octet cap.
        const to = Array.from({ length: 15 }, (_, i) => `First Last <first.last${i}@somecompany.com>`);
        const msg = createEmailMessage({ to, subject: 'S', body: 'B' });
        const headerBlock = msg.split('\r\n\r\n')[0];
        for (const line of headerBlock.split('\r\n')) {
            assert.ok(line.length <= 78, `header line too long (${line.length}): ${line.slice(0, 40)}...`);
        }
        // Folding must not lose anyone.
        assert.equal((headerBlock.match(/somecompany\.com/g) || []).length, 15);
    });
});
