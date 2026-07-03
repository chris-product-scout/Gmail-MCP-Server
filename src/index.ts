#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { google } from 'googleapis';
import { z } from "zod";
import { OAuth2Client } from 'google-auth-library';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import open from 'open';
import os from 'os';
import {createEmailMessage, createEmailWithNodemailer} from "./utl.js";
import { createLabel, updateLabel, deleteLabel, listLabels, findLabelByName, getOrCreateLabel, GmailLabel } from "./label-manager.js";
import { createFilter, listFilters, getFilter, deleteFilter, filterTemplates, GmailFilterCriteria, GmailFilterAction } from "./filter-manager.js";
import { convert as htmlToText } from 'html-to-text';
import { loadMultiAccountTokens, createAccountClients, filterByAllowedAccounts, resolveAccountId, type AccountClients } from './token-manager.js';
import {
    withAccount,
    SendEmailSchema, ReadEmailSchema, SearchEmailsSchema, ModifyEmailSchema,
    DeleteEmailSchema, ListEmailLabelsSchema, CreateLabelSchema, UpdateLabelSchema,
    DeleteLabelSchema, GetOrCreateLabelSchema, BatchModifyEmailsSchema, BatchDeleteEmailsSchema,
    BatchReadEmailsSchema, CreateFilterSchema, ListFiltersSchema, GetFilterSchema,
    DeleteFilterSchema, CreateFilterFromTemplateSchema, DownloadAttachmentSchema,
    GetThreadMessagesSchema, ArchiveThreadSchema, GetDraftsSchema, UpdateDraftSchema,
    DeleteDraftSchema, SendDraftSchema,
} from './schemas.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Configuration paths
const CONFIG_DIR = path.join(os.homedir(), '.gmail-mcp');
const OAUTH_PATH = process.env.GMAIL_OAUTH_PATH || path.join(CONFIG_DIR, 'gcp-oauth.keys.json');
const CREDENTIALS_PATH = process.env.GMAIL_CREDENTIALS_PATH || path.join(CONFIG_DIR, 'credentials.json');
const GMAIL_TOKEN_PATH = process.env.GMAIL_TOKEN_PATH || CREDENTIALS_PATH;

// Type definitions for Gmail API responses
interface GmailMessagePart {
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

interface EmailAttachment {
    id: string;
    filename: string;
    mimeType: string;
    size: number;
}

interface EmailContent {
    text: string;
    html: string;
}

// OAuth2 configuration
let oauth2Client: OAuth2Client;
let accountsMap: Map<string, AccountClients> = new Map();

/**
 * Recursively extract email body content from MIME message parts
 * Handles complex email structures with nested parts
 */
function extractEmailContent(messagePart: GmailMessagePart): EmailContent {
    // Initialize containers for different content types
    let textContent = '';
    let htmlContent = '';

    // If the part has a body with data, process it based on MIME type
    if (messagePart.body && messagePart.body.data) {
        const content = Buffer.from(messagePart.body.data, 'base64').toString('utf8');

        // Store content based on its MIME type
        if (messagePart.mimeType === 'text/plain') {
            textContent = content;
        } else if (messagePart.mimeType === 'text/html') {
            htmlContent = content;
        }
    }

    // If the part has nested parts, recursively process them
    if (messagePart.parts && messagePart.parts.length > 0) {
        for (const part of messagePart.parts) {
            const { text, html } = extractEmailContent(part);
            if (text) textContent += text;
            if (html) htmlContent += html;
        }
    }

    // Return both plain text and HTML content
    return { text: textContent, html: htmlContent };
}

/**
 * Extract body text from a Gmail message payload.
 * Prefers plain text, falls back to HTML-to-text conversion, then regex strip.
 */
function getBodyText(payload: GmailMessagePart, maxLength: number = 50000): string {
    const { text, html } = extractEmailContent(payload);
    let body = text;
    if (!body && html) {
        try {
            body = htmlToText(html, {
                wordwrap: false,
                selectors: [
                    { selector: 'img', format: 'skip' },
                    { selector: 'a', options: { ignoreHref: true } }
                ]
            });
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

/**
 * Build a multipart/mixed batch request body for the Gmail batch API.
 */
function buildBatchRequest(messageIds: string[]): { body: string; boundary: string } {
    const boundary = `batch_${Date.now()}_${Math.random().toString(36).substring(2)}`;
    const parts = messageIds.map(id =>
        `--${boundary}\r\nContent-Type: application/http\r\nContent-ID: <${id}>\r\n\r\nGET /gmail/v1/users/me/messages/${id}?format=full\r\n`
    );
    const body = parts.join('\r\n') + `\r\n--${boundary}--`;
    return { body, boundary };
}

/**
 * Parse a Gmail batch API multipart response into individual message results.
 * IMPORTANT: The boundary must be extracted from the response Content-Type header,
 * NOT reused from the request — Google generates its own boundary in the response.
 */
function parseBatchResponse(responseText: string, boundary: string): Array<{ id: string; data?: any; error?: string }> {
    const results: Array<{ id: string; data?: any; error?: string }> = [];
    const parts = responseText.split(`--${boundary}`);

    for (const part of parts) {
        const trimmed = part.trim();
        if (!trimmed || trimmed === '--') continue;

        // Extract Content-ID from the MIME part headers (maps back to our request ID)
        const contentIdMatch = trimmed.match(/Content-ID:\s*<?\s*response-([^>\s]+)/i);
        const contentId = contentIdMatch ? contentIdMatch[1] : null;

        // Find the blank line that separates MIME headers from the HTTP response
        const httpResponseStart = trimmed.indexOf('\r\n\r\n');
        if (httpResponseStart === -1) continue;

        const httpResponse = trimmed.substring(httpResponseStart + 4);

        // The HTTP response itself has a status line, headers, then body
        const bodyStart = httpResponse.indexOf('\r\n\r\n');
        if (bodyStart === -1) continue;

        const statusLine = httpResponse.substring(0, httpResponse.indexOf('\r\n'));
        const statusMatch = statusLine.match(/HTTP\/[\d.]+ (\d+)/);
        const statusCode = statusMatch ? parseInt(statusMatch[1]) : 0;

        const jsonBody = httpResponse.substring(bodyStart + 4).trim();

        try {
            const data = JSON.parse(jsonBody);
            if (statusCode === 200) {
                results.push({ id: data.id, data });
            } else {
                // Use Content-ID to identify which request failed, fall back to response body
                results.push({
                    id: data.id || contentId || 'unknown',
                    error: `HTTP ${statusCode}: ${data.error?.message || 'Unknown error'}`
                });
            }
        } catch {
            results.push({ id: contentId || 'unknown', error: `Failed to parse response part (HTTP ${statusCode})` });
        }
    }

    return results;
}

async function loadCredentials() {
    try {
        // Create config directory if it doesn't exist
        if (!process.env.GMAIL_OAUTH_PATH && !fs.existsSync(CONFIG_DIR)) {
            fs.mkdirSync(CONFIG_DIR, { recursive: true });
        }

        // Check for OAuth keys in current directory first, then in config directory
        const localOAuthPath = path.join(process.cwd(), 'gcp-oauth.keys.json');

        if (fs.existsSync(localOAuthPath)) {
            fs.copyFileSync(localOAuthPath, OAUTH_PATH);
            console.log('OAuth keys found in current directory, copied to global config.');
        }

        if (!fs.existsSync(OAUTH_PATH)) {
            console.error('Error: OAuth keys file not found. Please place gcp-oauth.keys.json in current directory or', CONFIG_DIR);
            process.exit(1);
        }

        const keysContent = JSON.parse(fs.readFileSync(OAUTH_PATH, 'utf8'));
        const keys = keysContent.installed || keysContent.web;

        if (!keys) {
            console.error('Error: Invalid OAuth keys file format. File should contain either "installed" or "web" credentials.');
            process.exit(1);
        }

        if (process.argv[2] === 'auth') {
            // Auth mode: single client for interactive OAuth flow
            const callback = process.argv[3] || "http://localhost:3000/oauth2callback";
            oauth2Client = new OAuth2Client(keys.client_id, keys.client_secret, callback);
            if (fs.existsSync(CREDENTIALS_PATH)) {
                const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
                oauth2Client.setCredentials(credentials);
            }
        } else {
            // Server mode: load multi-account tokens
            if (!fs.existsSync(GMAIL_TOKEN_PATH)) {
                console.error(`Error: Token file not found: ${GMAIL_TOKEN_PATH}`);
                process.exit(1);
            }
            const tokens = loadMultiAccountTokens(GMAIL_TOKEN_PATH);
            accountsMap = filterByAllowedAccounts(
                createAccountClients(tokens, { client_id: keys.client_id, client_secret: keys.client_secret }, GMAIL_TOKEN_PATH)
            );
            const accountNames = Array.from(accountsMap.keys()).join(', ');
            process.stderr.write(`Loaded ${accountsMap.size} account(s): ${accountNames}\n`);
        }
    } catch (error) {
        console.error('Error loading credentials:', error);
        process.exit(1);
    }
}

async function authenticate() {
    const server = http.createServer();
    server.listen(3000);

    return new Promise<void>((resolve, reject) => {
        const authUrl = oauth2Client.generateAuthUrl({
            access_type: 'offline',
            scope: [
                'https://www.googleapis.com/auth/gmail.modify', // Change to 'gmail.readonly' for read-only mode
                'https://www.googleapis.com/auth/gmail.settings.basic'
            ],
        });

        console.log('Please visit this URL to authenticate:', authUrl);
        open(authUrl);

        server.on('request', async (req, res) => {
            if (!req.url?.startsWith('/oauth2callback')) return;

            const url = new URL(req.url, 'http://localhost:3000');
            const code = url.searchParams.get('code');

            if (!code) {
                res.writeHead(400);
                res.end('No code provided');
                reject(new Error('No code provided'));
                return;
            }

            try {
                const { tokens } = await oauth2Client.getToken(code);
                oauth2Client.setCredentials(tokens);
                fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(tokens));

                res.writeHead(200);
                res.end('Authentication successful! You can close this window.');
                server.close();
                resolve();
            } catch (error) {
                res.writeHead(500);
                res.end('Authentication failed');
                reject(error);
            }
        });
    });
}

// Helper to resolve account and get Gmail/OAuth clients for a tool call
function getClients(account?: string) {
    const accountId = resolveAccountId(accountsMap, account);
    const clients = accountsMap.get(accountId)!;
    return { gmail: clients.gmail, oauth2Client: clients.oauth2Client };
}

// Resolve Gmail message ID to RFC 2822 Message-ID header and reply-all recipients
async function resolveReplyMetadata(gmail: any, gmailMessageId: string): Promise<{
    rfc2822MessageId: string;
    subject?: string;
    replyAllTo: string[];
    replyAllCc: string[];
    threadId?: string;
}> {
    const response = await gmail.users.messages.get({
        userId: 'me',
        id: gmailMessageId,
        format: 'metadata',
        metadataHeaders: ['Message-ID', 'Subject', 'From', 'To', 'Cc', 'Reply-To'],
    });
    const headers = response.data.payload?.headers || [];
    const getHeader = (name: string) => headers.find((h: any) => h.name === name)?.value || '';

    const messageIdHeader = getHeader('Message-ID');
    const subject = getHeader('Subject');
    const replyTo = getHeader('Reply-To');
    const from = getHeader('From');
    const to = getHeader('To');
    const cc = getHeader('Cc');

    // Get the authenticated user's email to exclude from recipients
    const profile = await gmail.users.getProfile({ userId: 'me' });
    const myEmail = (profile.data.emailAddress || '').toLowerCase();

    // Parse comma-separated email lists, filtering out our own address
    const parseAddresses = (header: string): string[] =>
        header.split(',').map(s => s.trim()).filter(s => s && !s.toLowerCase().includes(myEmail));

    // Reply-All: To = Reply-To or From; CC = original To + CC minus ourselves
    const replyAllTo = replyTo ? [replyTo] : from ? [from] : [];
    const replyAllCc = [...parseAddresses(to), ...parseAddresses(cc)];

    return {
        rfc2822MessageId: messageIdHeader || gmailMessageId,
        subject,
        replyAllTo,
        replyAllCc,
        threadId: response.data.threadId || undefined,
    };
}

// Shared email action handler for send_email and draft_email
async function handleEmailAction(action: "send" | "draft", validatedArgs: any, gmail: any) {
    let message: string;

    try {
        // Resolve inReplyTo: fetch RFC 2822 Message-ID and auto-populate reply-all recipients
        if (validatedArgs.inReplyTo) {
            const resolved = await resolveReplyMetadata(gmail, validatedArgs.inReplyTo);
            validatedArgs.inReplyTo = resolved.rfc2822MessageId;
            // Auto-thread: file into the replied-to message's thread unless the caller set one.
            // Without this, a reply with only inReplyTo lands as a brand-new thread in the mailbox.
            if (!validatedArgs.threadId && resolved.threadId) {
                validatedArgs.threadId = resolved.threadId;
            }
            // Add Re: prefix to subject if this is a reply and subject doesn't already have it
            if (validatedArgs.subject && !validatedArgs.subject.match(/^Re:/i) && resolved.subject) {
                validatedArgs.subject = `Re: ${resolved.subject}`;
            }
            // Auto-populate reply recipients if caller didn't explicitly set them
            if (!validatedArgs.to || validatedArgs.to.length === 0) {
                validatedArgs.to = resolved.replyAllTo;
            }
            // Auto-populate CC with reply-all recipients unless replyAll is explicitly false
            if (validatedArgs.replyAll !== false && (!validatedArgs.cc || validatedArgs.cc.length === 0)) {
                if (resolved.replyAllCc.length > 0) {
                    validatedArgs.cc = resolved.replyAllCc;
                }
            }
        }

        if (validatedArgs.attachments && validatedArgs.attachments.length > 0) {
            message = await createEmailWithNodemailer(validatedArgs);
        } else {
            message = createEmailMessage(validatedArgs);
        }

        const encodedMessage = Buffer.from(message).toString('base64')
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '');

        const messageRequest: { raw: string; threadId?: string } = { raw: encodedMessage };
        if (validatedArgs.threadId) {
            messageRequest.threadId = validatedArgs.threadId;
        }

        if (action === "send") {
            const response = await gmail.users.messages.send({
                userId: 'me',
                requestBody: messageRequest,
            });
            return { content: [{ type: "text" as const, text: `Email sent successfully with ID: ${response.data.id}` }] };
        } else {
            const response = await gmail.users.drafts.create({
                userId: 'me',
                requestBody: { message: messageRequest },
            });
            return { content: [{ type: "text" as const, text: `Email draft created successfully with ID: ${response.data.id}` }] };
        }
    } catch (error: any) {
        if (validatedArgs.attachments && validatedArgs.attachments.length > 0) {
            console.error(`Failed to send email with ${validatedArgs.attachments.length} attachments:`, error.message);
        }
        throw error;
    }
}

// Main function
async function main() {
    await loadCredentials();

    if (process.argv[2] === 'auth') {
        await authenticate();
        console.log('Authentication completed successfully');
        process.exit(0);
    }

    const server = new McpServer({ name: "gmail", version: "2.0.0" });

    // ── Safe mode: read + draft only (opt-in via GMAIL_SAFE_MODE=1) ──
    // For untrusted deployments (e.g. a shared server / agent) that should be
    // able to READ mail and CREATE/EDIT drafts, but must never send, delete,
    // archive, relabel, or change filters. Enforced by not registering the
    // capability at all — an absent tool cannot be called.
    //
    // Default-deny: only the names below are exposed; anything else (including
    // tools added by future updates) is blocked until explicitly allowlisted.
    // Leave GMAIL_SAFE_MODE unset for full behavior (unchanged default).
    const SAFE_MODE = process.env.GMAIL_SAFE_MODE === '1';
    const SAFE_MODE_ALLOWED = new Set<string>([
        // read / search
        "read_email", "search_emails", "get_thread_messages", "batch_read_emails",
        "get_drafts", "list_email_labels", "list_filters", "get_filter",
        "download_attachment",
        // draft create + edit (never sends)
        "draft_email", "update_draft",
    ]);
    if (SAFE_MODE) {
        const _registerTool = (server.registerTool as any).bind(server);
        (server as any).registerTool = (name: string, ...rest: any[]) => {
            if (!SAFE_MODE_ALLOWED.has(name)) {
                return; // skip: blocked in safe mode
            }
            return _registerTool(name, ...rest);
        };
        console.error(
            `[gmail-mcp] GMAIL_SAFE_MODE on — exposing read + draft only: ` +
            `${[...SAFE_MODE_ALLOWED].sort().join(", ")}. ` +
            `Blocked: send_email, send_draft, delete_email, batch_delete_emails, ` +
            `modify_email, batch_modify_emails, archive_thread, delete_draft, ` +
            `label CRUD, filter CRUD.`
        );
    }

    // ── Send & Draft Tools ──────────────────────────────────────────

    server.registerTool("send_email", {
        description: "Sends a new email",
        inputSchema: withAccount(SendEmailSchema.shape),
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    }, async (args) => {
        const { gmail } = getClients(args.account);
        return await handleEmailAction("send", args, gmail);
    });

    server.registerTool("draft_email", {
        description: "Draft a new email",
        inputSchema: withAccount(SendEmailSchema.shape),
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    }, async (args) => {
        const { gmail } = getClients(args.account);
        return await handleEmailAction("draft", args, gmail);
    });

    server.registerTool("get_drafts", {
        description: "Get drafts. With draftId: returns full content. Without draftId: lists all drafts with subject, recipients, and date.",
        inputSchema: withAccount(GetDraftsSchema.shape),
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    }, async (args) => {
        const { gmail } = getClients(args.account);

        if (args.draftId) {
            const response = await gmail.users.drafts.get({ userId: 'me', id: args.draftId, format: 'full' });
            const message = response.data.message;
            const headers = message?.payload?.headers || [];
            const subject = headers.find((h: any) => h.name?.toLowerCase() === 'subject')?.value || '(no subject)';
            const from = headers.find((h: any) => h.name?.toLowerCase() === 'from')?.value || '';
            const to = headers.find((h: any) => h.name?.toLowerCase() === 'to')?.value || '';
            const cc = headers.find((h: any) => h.name?.toLowerCase() === 'cc')?.value || '';
            const date = headers.find((h: any) => h.name?.toLowerCase() === 'date')?.value || '';
            const body = getBodyText(message?.payload as GmailMessagePart || {});
            return {
                content: [{ type: "text" as const, text: `Draft ID: ${response.data.id}\nMessage ID: ${message?.id || ''}\nThread ID: ${message?.threadId || ''}\nSubject: ${subject}\nFrom: ${from}\nTo: ${to}${cc ? `\nCc: ${cc}` : ''}\nDate: ${date}\n\n${body}` }],
            };
        } else {
            const listResponse = await gmail.users.drafts.list({
                userId: 'me',
                ...(args.maxResults && { maxResults: args.maxResults }),
                ...(args.pageToken && { pageToken: args.pageToken }),
                ...(args.q && { q: args.q }),
            });
            const drafts = listResponse.data.drafts || [];
            if (drafts.length === 0) {
                return { content: [{ type: "text" as const, text: "No drafts found." }] };
            }
            const draftDetails = await Promise.all(
                drafts.map(async (d: any) => {
                    try {
                        const detail = await gmail.users.drafts.get({ userId: 'me', id: d.id!, format: 'metadata' });
                        const headers = detail.data.message?.payload?.headers || [];
                        const subject = headers.find((h: any) => h.name?.toLowerCase() === 'subject')?.value || '(no subject)';
                        const to = headers.find((h: any) => h.name?.toLowerCase() === 'to')?.value || '';
                        const date = headers.find((h: any) => h.name?.toLowerCase() === 'date')?.value || '';
                        return `Draft ID: ${d.id}\nTo: ${to}\nSubject: ${subject}\nDate: ${date}`;
                    } catch {
                        return `Draft ID: ${d.id} (could not fetch metadata)`;
                    }
                })
            );
            let text = `Found ${drafts.length} draft(s):\n\n` + draftDetails.join('\n\n');
            if (listResponse.data.nextPageToken) {
                text += `\n\nNext page token: ${listResponse.data.nextPageToken}`;
            }
            return { content: [{ type: "text" as const, text }] };
        }
    });

    server.registerTool("update_draft", {
        description: "Replace an existing draft's content. Fully overwrites the draft — include all message fields, including attachments (re-list every file to keep, or they are dropped).",
        inputSchema: withAccount(UpdateDraftSchema.shape),
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    }, async (args) => {
        const { gmail } = getClients(args.account);
        // Resolve inReplyTo: fetch RFC 2822 Message-ID and auto-populate reply-all recipients
        if (args.inReplyTo) {
            const resolved = await resolveReplyMetadata(gmail, args.inReplyTo);
            args.inReplyTo = resolved.rfc2822MessageId;
            // Auto-thread: file into the replied-to message's thread unless the caller set one.
            if (!args.threadId && resolved.threadId) {
                args.threadId = resolved.threadId;
            }
            if (args.subject && !args.subject.match(/^Re:/i) && resolved.subject) {
                args.subject = `Re: ${resolved.subject}`;
            }
            if (!args.to || args.to.length === 0) {
                args.to = resolved.replyAllTo;
            }
            if (args.replyAll !== false && (!args.cc || args.cc.length === 0)) {
                if (resolved.replyAllCc.length > 0) {
                    args.cc = resolved.replyAllCc;
                }
            }
        }
        // Build with attachments (nodemailer) when present, else the plain builder.
        // update fully overwrites the draft, so callers must re-list attachments to keep them.
        const message = (args.attachments && args.attachments.length > 0)
            ? await createEmailWithNodemailer(args)
            : createEmailMessage(args);
        const encodedMessage = Buffer.from(message).toString('base64')
            .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        const messageRequest: any = { raw: encodedMessage };
        if (args.threadId) messageRequest.threadId = args.threadId;
        const response = await gmail.users.drafts.update({
            userId: 'me', id: args.draftId,
            requestBody: { id: args.draftId, message: messageRequest },
        });
        return { content: [{ type: "text" as const, text: `Draft ${response.data.id} updated successfully.` }] };
    });

    server.registerTool("delete_draft", {
        description: "Permanently delete a draft. Cannot be undone.",
        inputSchema: withAccount(DeleteDraftSchema.shape),
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    }, async (args) => {
        const { gmail } = getClients(args.account);
        await gmail.users.drafts.delete({ userId: 'me', id: args.draftId });
        return { content: [{ type: "text" as const, text: `Draft ${args.draftId} deleted successfully.` }] };
    });

    server.registerTool("send_draft", {
        description: "Send an existing draft to its recipients.",
        inputSchema: withAccount(SendDraftSchema.shape),
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    }, async (args) => {
        const { gmail } = getClients(args.account);
        const response = await gmail.users.drafts.send({ userId: 'me', requestBody: { id: args.draftId } });
        return { content: [{ type: "text" as const, text: `Draft sent successfully. Message ID: ${response.data.id}` }] };
    });

    // ── Read & Search Tools ─────────────────────────────────────────

    server.registerTool("read_email", {
        description: "Retrieves the content of a specific email",
        inputSchema: withAccount(ReadEmailSchema.shape),
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    }, async (args) => {
        const { gmail } = getClients(args.account);
        const response = await gmail.users.messages.get({ userId: 'me', id: args.messageId, format: 'full' });

        const headers = response.data.payload?.headers || [];
        const subject = headers.find((h: any) => h.name?.toLowerCase() === 'subject')?.value || '';
        const from = headers.find((h: any) => h.name?.toLowerCase() === 'from')?.value || '';
        const to = headers.find((h: any) => h.name?.toLowerCase() === 'to')?.value || '';
        const cc = headers.find((h: any) => h.name?.toLowerCase() === 'cc')?.value || '';
        const replyTo = headers.find((h: any) => h.name?.toLowerCase() === 'reply-to')?.value || '';
        const date = headers.find((h: any) => h.name?.toLowerCase() === 'date')?.value || '';
        const threadId = response.data.threadId || '';
        const body = getBodyText(response.data.payload as GmailMessagePart || {});

        const attachments: EmailAttachment[] = [];
        const processAttachmentParts = (part: GmailMessagePart, partPath: string = '') => {
            if (part.body && part.body.attachmentId) {
                attachments.push({
                    id: part.body.attachmentId,
                    filename: part.filename || `attachment-${part.body.attachmentId}`,
                    mimeType: part.mimeType || 'application/octet-stream',
                    size: part.body.size || 0,
                });
            }
            if (part.parts) {
                part.parts.forEach((subpart: GmailMessagePart) => processAttachmentParts(subpart, `${partPath}/parts`));
            }
        };
        if (response.data.payload) processAttachmentParts(response.data.payload as GmailMessagePart);

        const attachmentInfo = attachments.length > 0 ?
            `\n\nAttachments (${attachments.length}):\n` +
            attachments.map(a => `- ${a.filename} (${a.mimeType}, ${Math.round(a.size/1024)} KB, ID: ${a.id})`).join('\n') : '';

        return {
            content: [{ type: "text" as const, text: `Thread ID: ${threadId}\nSubject: ${subject}\nFrom: ${from}\nTo: ${to}${cc ? `\nCc: ${cc}` : ''}${replyTo ? `\nReply-To: ${replyTo}` : ''}\nDate: ${date}\n\n${body}${attachmentInfo}` }],
        };
    });

    server.registerTool("search_emails", {
        description: "Searches for emails using Gmail search syntax",
        inputSchema: withAccount(SearchEmailsSchema.shape),
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    }, async (args) => {
        const { gmail } = getClients(args.account);
        const response = await gmail.users.messages.list({ userId: 'me', q: args.query, maxResults: args.maxResults || 10 });

        const messages = response.data.messages || [];
        const results = await Promise.all(
            messages.map(async (msg: any) => {
                const detail = await gmail.users.messages.get({ userId: 'me', id: msg.id!, format: 'metadata', metadataHeaders: ['Subject', 'From', 'Date'] });
                const headers = detail.data.payload?.headers || [];
                return {
                    id: msg.id,
                    subject: headers.find((h: any) => h.name === 'Subject')?.value || '',
                    from: headers.find((h: any) => h.name === 'From')?.value || '',
                    date: headers.find((h: any) => h.name === 'Date')?.value || '',
                };
            })
        );

        return {
            content: [{ type: "text" as const, text: results.map(r => `ID: ${r.id}\nSubject: ${r.subject}\nFrom: ${r.from}\nDate: ${r.date}\n`).join('\n') }],
        };
    });

    server.registerTool("get_thread_messages", {
        description: `Retrieves all messages in a thread by thread ID.

Use this tool when you need to find all related messages in a conversation thread - including replies, forwards, and the original message.

Common use case: After reading an email with read_email (which returns Thread ID), use this tool to get all messages in that thread, then use batch_modify_emails to archive them all.

Returns: Message ID, subject, sender, and date for each message in the thread.`,
        inputSchema: withAccount(GetThreadMessagesSchema.shape),
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    }, async (args) => {
        const { gmail } = getClients(args.account);

        try {
            const response = await gmail.users.threads.get({ userId: 'me', id: args.threadId, format: 'metadata', metadataHeaders: ['Subject', 'From', 'Date'] });
            const messages = response.data.messages || [];

            if (messages.length === 0) {
                return { content: [{ type: "text" as const, text: `Thread ${args.threadId} exists but contains no messages.` }] };
            }

            const results = messages.map((msg: any) => {
                const headers = msg.payload?.headers || [];
                return {
                    id: msg.id, threadId: msg.threadId,
                    subject: headers.find((h: any) => h.name === 'Subject')?.value || '',
                    from: headers.find((h: any) => h.name === 'From')?.value || '',
                    date: headers.find((h: any) => h.name === 'Date')?.value || '',
                };
            });

            return {
                content: [{ type: "text" as const, text: `Found ${results.length} message(s) in thread:\n\n` + results.map((r: any) => `ID: ${r.id}\nSubject: ${r.subject}\nFrom: ${r.from}\nDate: ${r.date}`).join('\n\n') }],
            };
        } catch (error: any) {
            if (error.code === 404) {
                return { content: [{ type: "text" as const, text: `Thread ${args.threadId} not found. Verify the thread ID is correct (get it from read_email output).` }], isError: true };
            }
            throw error;
        }
    });

    // ── Batch Tools ─────────────────────────────────────────────────

    server.registerTool("batch_read_emails", {
        description: `Fetch multiple email bodies in bulk using Gmail's batch API.

Use this instead of calling read_email in a loop. Fetches up to 100 emails in 1-2 HTTP requests.

Returns JSON array of {id, threadId, subject, from, date, body} objects.
Use output_path to write results to a file (recommended for 20+ emails to avoid token overflow).

Pairs with search_emails: first search to get IDs, then batch_read to get bodies.`,
        inputSchema: withAccount(BatchReadEmailsSchema.shape),
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    }, async (args) => {
        const { oauth2Client: batchOAuth } = getClients(args.account);
        const messageIds = args.messageIds;
        const maxBodyLength = args.maxBodyLength ?? 5000;

        if (messageIds.length === 0) {
            return { content: [{ type: "text" as const, text: "No message IDs provided." }] };
        }
        if (messageIds.length > 100) {
            return { content: [{ type: "text" as const, text: "Maximum 100 message IDs per call." }] };
        }

        const allResults: Array<{ id: string; threadId: string; subject: string; from: string; date: string; body: string; truncated: boolean }> = [];
        const failures: Array<{ id: string; error: string }> = [];

        async function executeBatch(batchIds: string[]) {
            const { body: requestBody, boundary: requestBoundary } = buildBatchRequest(batchIds);
            const response = await batchOAuth.request({
                url: 'https://www.googleapis.com/batch/gmail/v1',
                method: 'POST',
                headers: { 'Content-Type': `multipart/mixed; boundary=${requestBoundary}` },
                body: requestBody,
                responseType: 'text',
            });

            const hdrs = response.headers as any;
            const responseContentType = (typeof hdrs?.get === 'function' ? hdrs.get('content-type') : hdrs?.['content-type']) as string || '';
            const boundaryMatch = responseContentType.match(/boundary=(.+)/);
            if (!boundaryMatch) throw new Error('Could not extract boundary from batch response Content-Type header');
            const responseBoundary = boundaryMatch[1].trim();
            const responseText = typeof response.data === 'string' ? response.data : String(response.data);

            const parsed = parseBatchResponse(responseText, responseBoundary);
            const successIds = new Set<string>();
            const successes: typeof allResults = [];
            const retryIds: string[] = [];
            const hardFailures: typeof failures = [];

            for (const item of parsed) {
                if (item.error) {
                    if (item.error.includes('429')) retryIds.push(item.id);
                    else hardFailures.push({ id: item.id, error: item.error });
                    continue;
                }
                const msgData = item.data;
                successIds.add(msgData.id);
                const headers = msgData.payload?.headers || [];
                const subject = headers.find((h: any) => h.name?.toLowerCase() === 'subject')?.value || '';
                const from = headers.find((h: any) => h.name?.toLowerCase() === 'from')?.value || '';
                const date = headers.find((h: any) => h.name?.toLowerCase() === 'date')?.value || '';
                const rawBody = getBodyText(msgData.payload as GmailMessagePart || {}, maxBodyLength);
                successes.push({ id: msgData.id, threadId: msgData.threadId || '', subject, from, date, body: rawBody, truncated: maxBodyLength > 0 && rawBody.includes('[Truncated:') });
            }

            const knownIds = new Set([...successIds, ...hardFailures.map(f => f.id), ...retryIds.filter(id => id !== 'unknown')]);
            const missingIds = batchIds.filter(id => !knownIds.has(id));
            return { successes, retryIds: [...retryIds.filter(id => id !== 'unknown'), ...missingIds], hardFailures };
        }

        const BATCH_SIZE = 25;
        let pendingIds = [...messageIds];
        const MAX_RETRIES = 2;

        for (let attempt = 0; attempt <= MAX_RETRIES && pendingIds.length > 0; attempt++) {
            if (attempt > 0) await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
            const retryNextRound: string[] = [];
            for (let i = 0; i < pendingIds.length; i += BATCH_SIZE) {
                const batchIds = pendingIds.slice(i, i + BATCH_SIZE);
                const { successes, retryIds, hardFailures } = await executeBatch(batchIds);
                allResults.push(...successes);
                failures.push(...hardFailures);
                retryNextRound.push(...retryIds);
                if (i + BATCH_SIZE < pendingIds.length) await new Promise(resolve => setTimeout(resolve, 500));
            }
            pendingIds = retryNextRound;
        }

        for (const id of pendingIds) failures.push({ id, error: 'Rate limited after retries' });

        if (args.output_path) {
            fs.writeFileSync(args.output_path, JSON.stringify(allResults, null, 2));
            return {
                content: [{ type: "text" as const, text: `Batch read complete. ${allResults.length} emails written to ${args.output_path}` + (failures.length > 0 ? `\n${failures.length} failed: ${failures.map(f => `${f.id} (${f.error})`).join(', ')}` : '') }],
            };
        }

        return {
            content: [{ type: "text" as const, text: JSON.stringify(allResults, null, 2) + (failures.length > 0 ? `\n\nFailed (${failures.length}): ${failures.map(f => `${f.id} (${f.error})`).join(', ')}` : '') }],
        };
    });

    server.registerTool("batch_modify_emails", {
        description: "Modifies labels for multiple emails using Gmail's native batch API",
        inputSchema: withAccount(BatchModifyEmailsSchema.shape),
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    }, async (args) => {
        const { gmail } = getClients(args.account);
        if (args.messageIds.length === 0) {
            return { content: [{ type: "text" as const, text: "0 messages processed." }] };
        }
        const batchSize = args.batchSize || 1000;
        const batchRequestBody: any = {};
        if (args.addLabelIds) batchRequestBody.addLabelIds = args.addLabelIds;
        if (args.removeLabelIds) batchRequestBody.removeLabelIds = args.removeLabelIds;

        let successes = 0;
        const failures: { id: string, error: string }[] = [];

        for (let i = 0; i < args.messageIds.length; i += batchSize) {
            const chunk = args.messageIds.slice(i, i + batchSize);
            try {
                await gmail.users.messages.batchModify({
                    userId: 'me',
                    requestBody: { ids: chunk, ...batchRequestBody }
                });
                successes += chunk.length;
            } catch {
                // Batch failed — fall back to individual calls for this chunk
                for (const id of chunk) {
                    try {
                        await gmail.users.messages.modify({ userId: 'me', id, requestBody: batchRequestBody });
                        successes++;
                    } catch (e: any) {
                        failures.push({ id, error: e.message });
                    }
                }
            }
        }

        let resultText = `Batch label modification complete.\nSuccessfully processed: ${successes} messages\n`;
        if (failures.length > 0) {
            resultText += `Failed to process: ${failures.length} messages\n\nFailed message IDs:\n`;
            resultText += failures.map(f => `- ${f.id.substring(0, 16)}... (${f.error})`).join('\n');
        }
        return { content: [{ type: "text" as const, text: resultText }] };
    });

    server.registerTool("batch_delete_emails", {
        description: "Permanently deletes multiple emails using Gmail's native batch API. Note: cannot confirm individual message outcomes — silently ignores invalid or already-deleted IDs.",
        inputSchema: withAccount(BatchDeleteEmailsSchema.shape),
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    }, async (args) => {
        const { gmail } = getClients(args.account);
        if (args.messageIds.length === 0) {
            return { content: [{ type: "text" as const, text: "0 messages requested for deletion." }] };
        }
        const batchSize = args.batchSize || 1000;

        for (let i = 0; i < args.messageIds.length; i += batchSize) {
            const chunk = args.messageIds.slice(i, i + batchSize);
            await gmail.users.messages.batchDelete({
                userId: 'me',
                requestBody: { ids: chunk }
            });
        }

        return { content: [{ type: "text" as const, text: `Batch delete complete.\nRequested deletion: ${args.messageIds.length} messages` }] };
    });

    // ── Modify & Delete Tools ───────────────────────────────────────

    server.registerTool("modify_email", {
        description: "Modifies email labels (move to different folders)",
        inputSchema: withAccount(ModifyEmailSchema.shape),
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    }, async (args) => {
        const { gmail } = getClients(args.account);
        const requestBody: any = {};
        if (args.labelIds) requestBody.addLabelIds = args.labelIds;
        if (args.addLabelIds) requestBody.addLabelIds = args.addLabelIds;
        if (args.removeLabelIds) requestBody.removeLabelIds = args.removeLabelIds;
        await gmail.users.messages.modify({ userId: 'me', id: args.messageId, requestBody });
        return { content: [{ type: "text" as const, text: `Email ${args.messageId} labels updated successfully` }] };
    });

    server.registerTool("delete_email", {
        description: "Permanently deletes an email",
        inputSchema: withAccount(DeleteEmailSchema.shape),
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    }, async (args) => {
        const { gmail } = getClients(args.account);
        await gmail.users.messages.delete({ userId: 'me', id: args.messageId });
        return { content: [{ type: "text" as const, text: `Email ${args.messageId} deleted successfully` }] };
    });

    server.registerTool("archive_thread", {
        description: `Archives an entire email thread by removing the INBOX label from all messages in a single atomic operation.

Use this tool when you want to archive an email conversation. This is the PREFERRED way to archive emails.

Get the threadId from read_email output (shown as "Thread ID: ...").`,
        inputSchema: withAccount(ArchiveThreadSchema.shape),
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    }, async (args) => {
        const { gmail } = getClients(args.account);

        try {
            const response = await gmail.users.threads.modify({
                userId: 'me',
                id: args.threadId,
                requestBody: { removeLabelIds: ['INBOX'] }
            });
            const messageCount = response.data.messages?.length || 0;
            return { content: [{ type: "text" as const, text: `Thread ${args.threadId} archived successfully.\nMessages archived: ${messageCount}` }] };
        } catch (error: any) {
            if (error.code === 404) {
                return { content: [{ type: "text" as const, text: `Thread ${args.threadId} not found. Verify the thread ID is correct (get it from read_email output).` }], isError: true };
            }
            throw error;
        }
    });

    // ── Label Tools ─────────────────────────────────────────────────

    server.registerTool("list_email_labels", {
        description: "Retrieves all available Gmail labels",
        inputSchema: withAccount(ListEmailLabelsSchema.shape),
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    }, async (args) => {
        const { gmail } = getClients(args.account);
        const labelResults = await listLabels(gmail);
        return {
            content: [{ type: "text" as const, text: `Found ${labelResults.count.total} labels (${labelResults.count.system} system, ${labelResults.count.user} user):\n\nSystem Labels:\n` + labelResults.system.map((l: GmailLabel) => `ID: ${l.id}\nName: ${l.name}\n`).join('\n') + "\nUser Labels:\n" + labelResults.user.map((l: GmailLabel) => `ID: ${l.id}\nName: ${l.name}\n`).join('\n') }],
        };
    });

    server.registerTool("create_label", {
        description: "Creates a new Gmail label",
        inputSchema: withAccount(CreateLabelSchema.shape),
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    }, async (args) => {
        const { gmail } = getClients(args.account);
        const result = await createLabel(gmail, args.name, {
            messageListVisibility: args.messageListVisibility,
            labelListVisibility: args.labelListVisibility,
        });
        return { content: [{ type: "text" as const, text: `Label created successfully:\nID: ${result.id}\nName: ${result.name}\nType: ${result.type}` }] };
    });

    server.registerTool("update_label", {
        description: "Updates an existing Gmail label",
        inputSchema: withAccount(UpdateLabelSchema.shape),
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    }, async (args) => {
        const { gmail } = getClients(args.account);
        const updates: any = {};
        if (args.name) updates.name = args.name;
        if (args.messageListVisibility) updates.messageListVisibility = args.messageListVisibility;
        if (args.labelListVisibility) updates.labelListVisibility = args.labelListVisibility;
        const result = await updateLabel(gmail, args.id, updates);
        return { content: [{ type: "text" as const, text: `Label updated successfully:\nID: ${result.id}\nName: ${result.name}\nType: ${result.type}` }] };
    });

    server.registerTool("delete_label", {
        description: "Deletes a Gmail label",
        inputSchema: withAccount(DeleteLabelSchema.shape),
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    }, async (args) => {
        const { gmail } = getClients(args.account);
        const result = await deleteLabel(gmail, args.id);
        return { content: [{ type: "text" as const, text: result.message }] };
    });

    server.registerTool("get_or_create_label", {
        description: "Gets an existing label by name or creates it if it doesn't exist",
        inputSchema: withAccount(GetOrCreateLabelSchema.shape),
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    }, async (args) => {
        const { gmail } = getClients(args.account);
        const result = await getOrCreateLabel(gmail, args.name, {
            messageListVisibility: args.messageListVisibility,
            labelListVisibility: args.labelListVisibility,
        });
        const action = result.type === 'user' && result.name === args.name ? 'found existing' : 'created new';
        return { content: [{ type: "text" as const, text: `Successfully ${action} label:\nID: ${result.id}\nName: ${result.name}\nType: ${result.type}` }] };
    });

    // ── Filter Tools ────────────────────────────────────────────────

    server.registerTool("create_filter", {
        description: "Creates a new Gmail filter with custom criteria and actions",
        inputSchema: withAccount(CreateFilterSchema.shape),
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    }, async (args) => {
        const { gmail } = getClients(args.account);
        const result = await createFilter(gmail, args.criteria, args.action);
        const criteriaText = Object.entries(args.criteria).filter(([_, v]) => v !== undefined).map(([k, v]) => `${k}: ${v}`).join(', ');
        const actionText = Object.entries(args.action).filter(([_, v]) => v !== undefined && (Array.isArray(v) ? v.length > 0 : true)).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join(', ');
        return { content: [{ type: "text" as const, text: `Filter created successfully:\nID: ${result.id}\nCriteria: ${criteriaText}\nActions: ${actionText}` }] };
    });

    server.registerTool("list_filters", {
        description: "Retrieves all Gmail filters",
        inputSchema: withAccount(ListFiltersSchema.shape),
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    }, async (args) => {
        const { gmail } = getClients(args.account);
        const result = await listFilters(gmail);
        if (result.filters.length === 0) {
            return { content: [{ type: "text" as const, text: "No filters found." }] };
        }
        const filtersText = result.filters.map((filter: any) => {
            const criteriaEntries = Object.entries(filter.criteria || {}).filter(([_, v]) => v !== undefined).map(([k, v]) => `${k}: ${v}`).join(', ');
            const actionEntries = Object.entries(filter.action || {}).filter(([_, v]) => v !== undefined && (Array.isArray(v) ? v.length > 0 : true)).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join(', ');
            return `ID: ${filter.id}\nCriteria: ${criteriaEntries}\nActions: ${actionEntries}\n`;
        }).join('\n');
        return { content: [{ type: "text" as const, text: `Found ${result.count} filters:\n\n${filtersText}` }] };
    });

    server.registerTool("get_filter", {
        description: "Gets details of a specific Gmail filter",
        inputSchema: withAccount(GetFilterSchema.shape),
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    }, async (args) => {
        const { gmail } = getClients(args.account);
        const result = await getFilter(gmail, args.filterId);
        const criteriaText = Object.entries(result.criteria || {}).filter(([_, v]) => v !== undefined).map(([k, v]) => `${k}: ${v}`).join(', ');
        const actionText = Object.entries(result.action || {}).filter(([_, v]) => v !== undefined && (Array.isArray(v) ? v.length > 0 : true)).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join(', ');
        return { content: [{ type: "text" as const, text: `Filter details:\nID: ${result.id}\nCriteria: ${criteriaText}\nActions: ${actionText}` }] };
    });

    server.registerTool("delete_filter", {
        description: "Deletes a Gmail filter",
        inputSchema: withAccount(DeleteFilterSchema.shape),
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    }, async (args) => {
        const { gmail } = getClients(args.account);
        const result = await deleteFilter(gmail, args.filterId);
        return { content: [{ type: "text" as const, text: result.message }] };
    });

    server.registerTool("create_filter_from_template", {
        description: "Creates a filter using a pre-defined template for common scenarios",
        inputSchema: withAccount(CreateFilterFromTemplateSchema.shape),
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    }, async (args) => {
        const { gmail } = getClients(args.account);
        const template = args.template;
        const params = args.parameters;

        let filterConfig;
        switch (template) {
            case 'fromSender':
                if (!params.senderEmail) throw new Error("senderEmail is required for fromSender template");
                filterConfig = filterTemplates.fromSender(params.senderEmail, params.labelIds, params.archive);
                break;
            case 'withSubject':
                if (!params.subjectText) throw new Error("subjectText is required for withSubject template");
                filterConfig = filterTemplates.withSubject(params.subjectText, params.labelIds, params.markAsRead);
                break;
            case 'withAttachments':
                filterConfig = filterTemplates.withAttachments(params.labelIds);
                break;
            case 'largeEmails':
                if (!params.sizeInBytes) throw new Error("sizeInBytes is required for largeEmails template");
                filterConfig = filterTemplates.largeEmails(params.sizeInBytes, params.labelIds);
                break;
            case 'containingText':
                if (!params.searchText) throw new Error("searchText is required for containingText template");
                filterConfig = filterTemplates.containingText(params.searchText, params.labelIds, params.markImportant);
                break;
            case 'mailingList':
                if (!params.listIdentifier) throw new Error("listIdentifier is required for mailingList template");
                filterConfig = filterTemplates.mailingList(params.listIdentifier, params.labelIds, params.archive);
                break;
            default:
                throw new Error(`Unknown template: ${template}`);
        }

        const result = await createFilter(gmail, filterConfig.criteria, filterConfig.action);
        return { content: [{ type: "text" as const, text: `Filter created from template '${template}':\nID: ${result.id}\nTemplate used: ${template}` }] };
    });

    // ── Attachment Tool ─────────────────────────────────────────────

    server.registerTool("download_attachment", {
        description: "Downloads an email attachment. Use savePath (directory to save into) and filename (desired filename) as separate params. Do NOT use saveToPath — that param does not exist and will be silently ignored.",
        inputSchema: withAccount(DownloadAttachmentSchema.shape),
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    }, async (args) => {
        const { gmail } = getClients(args.account);

        try {
            const attachmentResponse = await gmail.users.messages.attachments.get({
                userId: 'me', messageId: args.messageId, id: args.attachmentId,
            });

            if (!attachmentResponse.data.data) throw new Error('No attachment data received');

            const buffer = Buffer.from(attachmentResponse.data.data, 'base64url');
            const savePath = args.savePath || process.cwd();
            let filename = args.filename;

            if (!filename) {
                const messageResponse = await gmail.users.messages.get({ userId: 'me', id: args.messageId, format: 'full' });
                const findAttachment = (part: any): string | null => {
                    if (part.body && part.body.attachmentId === args.attachmentId) return part.filename || `attachment-${args.attachmentId}`;
                    if (part.parts) { for (const subpart of part.parts) { const found = findAttachment(subpart); if (found) return found; } }
                    return null;
                };
                filename = findAttachment(messageResponse.data.payload) || `attachment-${args.attachmentId}`;
            }

            if (!fs.existsSync(savePath)) fs.mkdirSync(savePath, { recursive: true });
            const fullPath = path.join(savePath, filename);
            fs.writeFileSync(fullPath, buffer);

            return { content: [{ type: "text" as const, text: `Attachment downloaded successfully:\nFile: ${filename}\nSize: ${buffer.length} bytes\nSaved to: ${fullPath}` }] };
        } catch (error: any) {
            return { content: [{ type: "text" as const, text: `Failed to download attachment: ${error.message}` }] };
        }
    });

    // ── Start Server ────────────────────────────────────────────────

    const transport = new StdioServerTransport();
    await server.connect(transport);
}

main().catch((error) => {
    console.error('Server error:', error);
    process.exit(1);
});
