import fs from 'fs';
import path from 'path';
import { lookup as mimeLookup } from 'mime-types';
import nodemailer from 'nodemailer';
// Deep import: nodemailer ships no `exports` map, so Node's ESM resolver allows it.
// The `/index.js` suffix is required at runtime; TS finds the types via @types/nodemailer.
import addressparser from 'nodemailer/lib/addressparser/index.js';
import * as mimeFuncsNs from 'nodemailer/lib/mime-funcs/index.js';

// mime-funcs is CJS (`module.exports = {...}`). Node's cjs-module-lexer only detects
// some of its keys as named ESM exports — `foldLines` and `encodeWord` are NOT among
// them and are reachable only via `default`. The .d.ts declares them as named exports,
// so tsc accepts the namespace import and the failure appears at runtime, not build.
const mimeFuncs = ((mimeFuncsNs as any).default ?? mimeFuncsNs) as typeof mimeFuncsNs;

/**
 * Helper function to encode email headers containing non-ASCII characters
 * according to RFC 2047 MIME specification
 */
function encodeEmailHeader(text: string): string {
    // Only encode if the text contains non-ASCII characters
    if (/[^\x00-\x7F]/.test(text)) {
        // Use MIME Words encoding (RFC 2047)
        return '=?UTF-8?B?' + Buffer.from(text).toString('base64') + '?=';
    }
    return text;
}

type ParsedAddress = { name: string; address: string };

/** An RFC 2047 encoded word, e.g. `=?UTF-8?Q?Jos=C3=A9?=`, anywhere in a string. */
const ENCODED_WORD = /=\?[^?]+\?[BbQq]\?[^?]*\?=/;

/**
 * Parse an address list, failing loudly on any entry that carries no address.
 *
 * `Andrea Wan` with no `<andrea@example.com>` is a caller mistake. Dropping the
 * entry would send the message to everyone else and tell nobody it happened, so
 * this throws instead. An empty string parses to no entries and does not throw.
 */
function parseOrThrow(value: string): ParsedAddress[] {
    const parsed = addressparser(value, { flatten: true });
    const missing = parsed.filter(a => !a.address);
    if (missing.length > 0) {
        const names = missing.map(a => JSON.stringify(a.name || '')).join(', ');
        throw new Error(
            `Recipient has no email address: ${names}. ` +
            `Use "Name <name@example.com>", or a bare address.`
        );
    }
    return parsed;
}

/**
 * Render one recipient as an RFC 5322 name-addr, e.g. `"Andrea Wan" <a@b.com>`.
 *
 * A name that already holds an RFC 2047 encoded word goes out untouched: RFC 2047
 * section 5 forbids an encoded word inside a quoted-string, and a client that sees
 * one quoted shows the raw `=?UTF-8?...?=` rather than the name.
 *
 * A non-ASCII name becomes encoded words, split at 52 bytes so no single word passes
 * RFC 2047's 75-character cap. This matches what nodemailer emits on the attachment
 * path, so the two builders agree.
 *
 * Any other name is quoted. Quoting is valid for every phrase, so this avoids having
 * to decide which specials need escaping; clients render the name without the quotes.
 */
function formatAddress(name: string, address: string): string {
    if (!name) return address;
    if (ENCODED_WORD.test(name)) return `${name} <${address}>`;
    if (/[^\x00-\x7F]/.test(name)) return `${mimeFuncs.encodeWord(name, 'Q', 52)} <${address}>`;
    return `"${name.replace(/[\\"]/g, '\\$&')}" <${address}>`;
}

/**
 * Normalize a recipient list into a single header value.
 *
 * Callers may pass bare addresses (`a@b.com`) or name-addr strings
 * (`Andrea Wan <a@b.com>`); both are accepted and both round-trip. Throws when an
 * entry carries no address.
 */
export function formatAddressList(recipients: string[]): string {
    return parseOrThrow(recipients.join(', '))
        .map(a => formatAddress(a.name, a.address))
        .join(', ');
}

/**
 * Split a header value into normalized name-addr entries, dropping `excludeAddress`.
 *
 * Used by the reply-all path so display names from the original message survive into
 * the reply. A naive `header.split(',')` breaks on a quoted display name that contains
 * a comma (`"Wan, Andrea" <a@b.com>`, a shape some clients emit), turning one
 * recipient into two malformed ones.
 */
export function parseAddressList(header: string, excludeAddress?: string): string[] {
    const exclude = (excludeAddress || '').toLowerCase();
    return parseOrThrow(header)
        .filter(a => a.address.toLowerCase() !== exclude)
        .map(a => formatAddress(a.name, a.address));
}

/**
 * Wrap a header line to RFC 5322's 78-character soft limit.
 *
 * Address and reference lists are the headers that grow without bound — 15 named
 * recipients, or a long thread's References chain, pass the 998-octet hard limit on a
 * single line. Folding happens on whitespace, so it never splits an encoded word.
 */
function foldHeader(line: string): string {
    return mimeFuncs.foldLines(line, 76);
}

export function createEmailMessage(validatedArgs: any): string {
    const encodedSubject = encodeEmailHeader(validatedArgs.subject);
    // Determine content type based on available content and explicit mimeType
    let mimeType = validatedArgs.mimeType || 'text/plain';

    // If htmlBody is provided and mimeType isn't explicitly set to text/plain,
    // use multipart/alternative to include both versions
    if (validatedArgs.htmlBody && mimeType !== 'text/plain') {
        mimeType = 'multipart/alternative';
    }

    // Generate a random boundary string for multipart messages
    const boundary = `----=_NextPart_${Math.random().toString(36).substring(2)}`;

    // Common email headers
    const emailParts = [
        'From: me',
        foldHeader(`To: ${formatAddressList(validatedArgs.to)}`),
        validatedArgs.cc ? foldHeader(`Cc: ${formatAddressList(validatedArgs.cc)}`) : '',
        validatedArgs.bcc ? foldHeader(`Bcc: ${formatAddressList(validatedArgs.bcc)}`) : '',
        `Subject: ${encodedSubject}`,
        // Add thread-related headers if specified
        validatedArgs.inReplyTo ? `In-Reply-To: ${validatedArgs.inReplyTo}` : '',
        (validatedArgs.references || validatedArgs.inReplyTo) ? foldHeader(`References: ${validatedArgs.references || validatedArgs.inReplyTo}`) : '',
        'MIME-Version: 1.0',
    ].filter(Boolean);

    // Construct the email based on the content type
    if (mimeType === 'multipart/alternative') {
        // Multipart email with both plain text and HTML
        emailParts.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
        emailParts.push('');
        
        // Plain text part
        emailParts.push(`--${boundary}`);
        emailParts.push('Content-Type: text/plain; charset=UTF-8');
        emailParts.push('Content-Transfer-Encoding: 7bit');
        emailParts.push('');
        emailParts.push(validatedArgs.body);
        emailParts.push('');
        
        // HTML part
        emailParts.push(`--${boundary}`);
        emailParts.push('Content-Type: text/html; charset=UTF-8');
        emailParts.push('Content-Transfer-Encoding: 7bit');
        emailParts.push('');
        emailParts.push(validatedArgs.htmlBody || validatedArgs.body); // Use body as fallback
        emailParts.push('');
        
        // Close the boundary
        emailParts.push(`--${boundary}--`);
    } else if (mimeType === 'text/html') {
        // HTML-only email
        emailParts.push('Content-Type: text/html; charset=UTF-8');
        emailParts.push('Content-Transfer-Encoding: 7bit');
        emailParts.push('');
        emailParts.push(validatedArgs.htmlBody || validatedArgs.body);
    } else {
        // Plain text email (default)
        emailParts.push('Content-Type: text/plain; charset=UTF-8');
        emailParts.push('Content-Transfer-Encoding: 7bit');
        emailParts.push('');
        emailParts.push(validatedArgs.body);
    }

    return emailParts.join('\r\n');
}


export async function createEmailWithNodemailer(validatedArgs: any): Promise<string> {
    // Create a nodemailer transporter (we won't actually send, just generate the message)
    const transporter = nodemailer.createTransport({
        streamTransport: true,
        newline: 'unix',
        buffer: true
    });

    // Prepare attachments for nodemailer
    const attachments = [];
    for (const filePath of validatedArgs.attachments) {
        if (!fs.existsSync(filePath)) {
            throw new Error(`File does not exist: ${filePath}`);
        }
        
        const fileName = path.basename(filePath);
        
        attachments.push({
            filename: fileName,
            path: filePath
        });
    }

    const mailOptions = {
        from: 'me', // Gmail API will replace this with the authenticated user
        to: validatedArgs.to.join(', '),
        cc: validatedArgs.cc?.join(', '),
        bcc: validatedArgs.bcc?.join(', '),
        subject: validatedArgs.subject,
        text: validatedArgs.body,
        html: validatedArgs.htmlBody,
        attachments: attachments,
        inReplyTo: validatedArgs.inReplyTo,
        references: validatedArgs.references || validatedArgs.inReplyTo
    };

    // Generate the raw message
    const info = await transporter.sendMail(mailOptions);
    const rawMessage = info.message.toString();
    
    return rawMessage;
}

