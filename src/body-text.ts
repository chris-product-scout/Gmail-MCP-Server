import { convert as htmlToText } from 'html-to-text';

export interface GmailMessagePart {
    partId?: string;
    mimeType?: string;
    filename?: string;
    headers?: Array<{
        name: string;
        value: string;
    }>;
    body?: {
        attachmentId?: string;
        size?: number;
        data?: string;
    };
    parts?: GmailMessagePart[];
}

export interface EmailContent {
    text: string;
    html: string;
}

/**
 * Share of the HTML text's distinct words that must be missing from the plain part
 * before the plain part counts as a stub. Measured on 344 two-part work emails
 * (2026-11-04): normal mail sits under 0.05, stub notices (ATS scorecards, Linear
 * digests, invoice receipts) sit at 0.33 and above; 0.25 and 0.30 flip the same set.
 */
const STUB_NOVEL_WORD_SHARE = 0.25;

/**
 * A plain part this long is a real rendering, not a stub. Every stub in the sample was
 * 580 characters or less; complete newsletters start around 3,000, and their HTML only
 * adds sponsor blocks and footers.
 */
const STUB_MAX_PLAIN_LENGTH = 2000;

/**
 * Invisible characters that marketing mail pads its hidden preheader with
 * (combining grapheme joiner, soft hyphen, zero-width space/joiners, direction marks,
 * word joiner, BOM).
 */
const INVISIBLE_FILLER = /[\u034f\u00ad\u200b-\u200f\u2060\ufeff]/g;

/**
 * Recursively extract email body content from MIME message parts
 * Handles complex email structures with nested parts
 */
export function extractEmailContent(messagePart: GmailMessagePart): EmailContent {
    let textContent = '';
    let htmlContent = '';

    if (messagePart.body && messagePart.body.data) {
        const content = Buffer.from(messagePart.body.data, 'base64').toString('utf8');
        if (messagePart.mimeType === 'text/plain') {
            textContent = content;
        } else if (messagePart.mimeType === 'text/html' && !messagePart.filename) {
            htmlContent = content;
        }
    }

    if (messagePart.parts && messagePart.parts.length > 0) {
        for (const part of messagePart.parts) {
            const { text, html } = extractEmailContent(part);
            if (text) textContent += text;
            if (html) htmlContent += html;
        }
    }

    return { text: textContent, html: htmlContent };
}

/** Convert HTML to readable text with invisible filler removed. Throws if conversion fails. */
function convertHtml(html: string): string {
    const text = htmlToText(html, {
        wordwrap: false,
        selectors: [
            { selector: 'img', format: 'skip' },
            { selector: 'a', options: { ignoreHref: true } }
        ]
    });
    return text
        .replace(INVISIBLE_FILLER, '')
        .replace(/^\s+$/gm, '')
        .replace(/[ \t ]+$/gm, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function wordSet(s: string): Set<string> {
    return new Set(s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []);
}

/**
 * True when the plain part leaves out content the HTML part carries: the HTML text is
 * longer and a large share of its words never appear in the plain part, and the plain part
 * is short. Senders such as ATS tools put a one-line notice in text/plain and the real
 * content only in text/html.
 */
export function plainIsStub(plain: string, htmlText: string): boolean {
    const plainLength = plain.trim().length;
    if (plainLength >= STUB_MAX_PLAIN_LENGTH) return false;
    if (htmlText.length <= plainLength) return false;
    const plainWords = wordSet(plain);
    const htmlWords = wordSet(htmlText);
    if (htmlWords.size === 0) return false;
    let missing = 0;
    for (const w of htmlWords) if (!plainWords.has(w)) missing++;
    return missing / htmlWords.size >= STUB_NOVEL_WORD_SHARE;
}

/**
 * The HTML conversion drops link targets, so append the plain part's URLs that the
 * HTML text lacks (document links, confirmation links). The plain part is a short stub
 * here, so this adds little.
 */
function withPlainLinks(htmlText: string, plain: string): string {
    const urls = [...new Set(plain.match(/https?:\/\/[^\s<>\[\]()"]+/g) || [])]
        .filter((u) => !htmlText.includes(u));
    return urls.length ? `${htmlText}\n\nLinks:\n${urls.join('\n')}` : htmlText;
}

/**
 * Extract body text from a Gmail message payload.
 * Uses text/plain when it exists, unless the plain part is a stub of the HTML part
 * (see plainIsStub); then uses the HTML converted to text, plus the plain part's links. With no plain part, converts
 * the HTML, falling back to a regex strip if conversion fails.
 */
export function getBodyText(payload: GmailMessagePart, maxLength: number = 50000): string {
    const { text, html } = extractEmailContent(payload);
    let body = text;
    if (body && html && body.trim().length < STUB_MAX_PLAIN_LENGTH) {
        try {
            const htmlText = convertHtml(html);
            if (plainIsStub(body, htmlText)) body = withPlainLinks(htmlText, body);
        } catch {
            // Keep the plain part if the HTML cannot be converted.
        }
    } else if (!body && html) {
        try {
            body = convertHtml(html);
        } catch {
            body = html
                .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
                .replace(/<[^>]+>/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();
            body = `[Note: HTML conversion failed, showing simplified text]\n\n${body}`;
        }
    }
    body = body || '';
    if (maxLength > 0 && body.length > maxLength) {
        body = body.substring(0, maxLength) + `\n\n[Truncated: ${body.length - maxLength} characters omitted]`;
    }
    return body;
}
