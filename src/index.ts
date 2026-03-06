#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { google } from 'googleapis';
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Configuration paths
const CONFIG_DIR = path.join(os.homedir(), '.gmail-mcp');
const OAUTH_PATH = process.env.GMAIL_OAUTH_PATH || path.join(CONFIG_DIR, 'gcp-oauth.keys.json');
const CREDENTIALS_PATH = process.env.GMAIL_CREDENTIALS_PATH || path.join(CONFIG_DIR, 'credentials.json');

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
        if (!process.env.GMAIL_OAUTH_PATH && !CREDENTIALS_PATH &&!fs.existsSync(CONFIG_DIR)) {
            fs.mkdirSync(CONFIG_DIR, { recursive: true });
        }

        // Check for OAuth keys in current directory first, then in config directory
        const localOAuthPath = path.join(process.cwd(), 'gcp-oauth.keys.json');
        let oauthPath = OAUTH_PATH;

        if (fs.existsSync(localOAuthPath)) {
            // If found in current directory, copy to config directory
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

        const callback = process.argv[2] === 'auth' && process.argv[3] 
        ? process.argv[3] 
        : "http://localhost:3000/oauth2callback";

        oauth2Client = new OAuth2Client(
            keys.client_id,
            keys.client_secret,
            callback
        );

        if (fs.existsSync(CREDENTIALS_PATH)) {
            const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
            oauth2Client.setCredentials(credentials);
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

// Schema definitions
const SendEmailSchema = z.object({
    to: z.array(z.string()).describe("List of recipient email addresses"),
    subject: z.string().describe("Email subject"),
    body: z.string().describe("Email body content (used for text/plain or when htmlBody not provided)"),
    htmlBody: z.string().optional().describe("HTML version of the email body"),
    mimeType: z.enum(['text/plain', 'text/html', 'multipart/alternative']).optional().default('text/plain').describe("Email content type"),
    cc: z.array(z.string()).optional().describe("List of CC recipients"),
    bcc: z.array(z.string()).optional().describe("List of BCC recipients"),
    threadId: z.string().optional().describe("Thread ID to reply to"),
    inReplyTo: z.string().optional().describe("Message ID being replied to"),
    attachments: z.array(z.string()).optional().describe("List of file paths to attach to the email"),
});

const ReadEmailSchema = z.object({
    messageId: z.string().describe("ID of the email message to retrieve"),
});

const SearchEmailsSchema = z.object({
    query: z.string().describe("Gmail search query (e.g., 'from:example@gmail.com')"),
    maxResults: z.number().optional().describe("Maximum number of results to return"),
});

// Updated schema to include removeLabelIds
const ModifyEmailSchema = z.object({
    messageId: z.string().describe("ID of the email message to modify"),
    labelIds: z.array(z.string()).optional().describe("List of label IDs to apply"),
    addLabelIds: z.array(z.string()).optional().describe("List of label IDs to add to the message"),
    removeLabelIds: z.array(z.string()).optional().describe("List of label IDs to remove from the message"),
});

const DeleteEmailSchema = z.object({
    messageId: z.string().describe("ID of the email message to delete"),
});

// New schema for listing email labels
const ListEmailLabelsSchema = z.object({}).describe("Retrieves all available Gmail labels");

// Label management schemas
const CreateLabelSchema = z.object({
    name: z.string().describe("Name for the new label"),
    messageListVisibility: z.enum(['show', 'hide']).optional().describe("Whether to show or hide the label in the message list"),
    labelListVisibility: z.enum(['labelShow', 'labelShowIfUnread', 'labelHide']).optional().describe("Visibility of the label in the label list"),
}).describe("Creates a new Gmail label");

const UpdateLabelSchema = z.object({
    id: z.string().describe("ID of the label to update"),
    name: z.string().optional().describe("New name for the label"),
    messageListVisibility: z.enum(['show', 'hide']).optional().describe("Whether to show or hide the label in the message list"),
    labelListVisibility: z.enum(['labelShow', 'labelShowIfUnread', 'labelHide']).optional().describe("Visibility of the label in the label list"),
}).describe("Updates an existing Gmail label");

const DeleteLabelSchema = z.object({
    id: z.string().describe("ID of the label to delete"),
}).describe("Deletes a Gmail label");

const GetOrCreateLabelSchema = z.object({
    name: z.string().describe("Name of the label to get or create"),
    messageListVisibility: z.enum(['show', 'hide']).optional().describe("Whether to show or hide the label in the message list"),
    labelListVisibility: z.enum(['labelShow', 'labelShowIfUnread', 'labelHide']).optional().describe("Visibility of the label in the label list"),
}).describe("Gets an existing label by name or creates it if it doesn't exist");

// Schemas for batch operations
const BatchModifyEmailsSchema = z.object({
    messageIds: z.array(z.string()).describe("List of message IDs to modify"),
    addLabelIds: z.array(z.string()).optional().describe("List of label IDs to add to all messages"),
    removeLabelIds: z.array(z.string()).optional().describe("List of label IDs to remove from all messages"),
    batchSize: z.number().optional().default(50).describe("Number of messages to process in each batch (default: 50)"),
});

const BatchDeleteEmailsSchema = z.object({
    messageIds: z.array(z.string()).describe("List of message IDs to delete"),
    batchSize: z.number().optional().default(50).describe("Number of messages to process in each batch (default: 50)"),
});

const BatchReadEmailsSchema = z.object({
    messageIds: z.array(z.string()).describe("List of message IDs to fetch"),
    maxBodyLength: z.coerce.number().optional().default(5000)
        .describe("Max characters of body text per email (default 5000). Set to 0 for no limit."),
    output_path: z.string().optional()
        .describe("File path to write JSON results. When provided, writes to file and returns only metadata."),
});

// Filter management schemas
const CreateFilterSchema = z.object({
    criteria: z.object({
        from: z.string().optional().describe("Sender email address to match"),
        to: z.string().optional().describe("Recipient email address to match"),
        subject: z.string().optional().describe("Subject text to match"),
        query: z.string().optional().describe("Gmail search query (e.g., 'has:attachment')"),
        negatedQuery: z.string().optional().describe("Text that must NOT be present"),
        hasAttachment: z.boolean().optional().describe("Whether to match emails with attachments"),
        excludeChats: z.boolean().optional().describe("Whether to exclude chat messages"),
        size: z.number().optional().describe("Email size in bytes"),
        sizeComparison: z.enum(['unspecified', 'smaller', 'larger']).optional().describe("Size comparison operator")
    }).describe("Criteria for matching emails"),
    action: z.object({
        addLabelIds: z.array(z.string()).optional().describe("Label IDs to add to matching emails"),
        removeLabelIds: z.array(z.string()).optional().describe("Label IDs to remove from matching emails"),
        forward: z.string().optional().describe("Email address to forward matching emails to")
    }).describe("Actions to perform on matching emails")
}).describe("Creates a new Gmail filter");

const ListFiltersSchema = z.object({}).describe("Retrieves all Gmail filters");

const GetFilterSchema = z.object({
    filterId: z.string().describe("ID of the filter to retrieve")
}).describe("Gets details of a specific Gmail filter");

const DeleteFilterSchema = z.object({
    filterId: z.string().describe("ID of the filter to delete")
}).describe("Deletes a Gmail filter");

const CreateFilterFromTemplateSchema = z.object({
    template: z.enum(['fromSender', 'withSubject', 'withAttachments', 'largeEmails', 'containingText', 'mailingList']).describe("Pre-defined filter template to use"),
    parameters: z.object({
        senderEmail: z.string().optional().describe("Sender email (for fromSender template)"),
        subjectText: z.string().optional().describe("Subject text (for withSubject template)"),
        searchText: z.string().optional().describe("Text to search for (for containingText template)"),
        listIdentifier: z.string().optional().describe("Mailing list identifier (for mailingList template)"),
        sizeInBytes: z.number().optional().describe("Size threshold in bytes (for largeEmails template)"),
        labelIds: z.array(z.string()).optional().describe("Label IDs to apply"),
        archive: z.boolean().optional().describe("Whether to archive (skip inbox)"),
        markAsRead: z.boolean().optional().describe("Whether to mark as read"),
        markImportant: z.boolean().optional().describe("Whether to mark as important")
    }).describe("Template-specific parameters")
}).describe("Creates a filter using a pre-defined template");

const DownloadAttachmentSchema = z.object({
    messageId: z.string().describe("ID of the email message containing the attachment"),
    attachmentId: z.string().describe("ID of the attachment to download"),
    filename: z.string().optional().describe("Filename to save the attachment as (if not provided, uses original filename)"),
    savePath: z.string().optional().describe("Directory path to save the attachment (defaults to current directory)"),
});

const GetThreadMessagesSchema = z.object({
    threadId: z.string().describe("ID of the thread to retrieve all messages from"),
});

const ArchiveThreadSchema = z.object({
    threadId: z.string().describe("ID of the thread to archive (get this from read_email output)"),
});

// Main function
async function main() {
    await loadCredentials();

    if (process.argv[2] === 'auth') {
        await authenticate();
        console.log('Authentication completed successfully');
        process.exit(0);
    }

    // Initialize Gmail API
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    // Server implementation
    const server = new Server({
        name: "gmail",
        version: "1.0.0",
        capabilities: {
            tools: {},
        },
    });

    // Tool handlers
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
            {
                name: "send_email",
                description: "Sends a new email",
                inputSchema: zodToJsonSchema(SendEmailSchema),
            },
            {
                name: "draft_email",
                description: "Draft a new email",
                inputSchema: zodToJsonSchema(SendEmailSchema),
            },
            {
                name: "read_email",
                description: "Retrieves the content of a specific email",
                inputSchema: zodToJsonSchema(ReadEmailSchema),
            },
            {
                name: "search_emails",
                description: "Searches for emails using Gmail search syntax",
                inputSchema: zodToJsonSchema(SearchEmailsSchema),
            },
            {
                name: "modify_email",
                description: "Modifies email labels (move to different folders)",
                inputSchema: zodToJsonSchema(ModifyEmailSchema),
            },
            {
                name: "delete_email",
                description: "Permanently deletes an email",
                inputSchema: zodToJsonSchema(DeleteEmailSchema),
            },
            {
                name: "list_email_labels",
                description: "Retrieves all available Gmail labels",
                inputSchema: zodToJsonSchema(ListEmailLabelsSchema),
            },
            {
                name: "batch_modify_emails",
                description: "Modifies labels for multiple emails in batches",
                inputSchema: zodToJsonSchema(BatchModifyEmailsSchema),
            },
            {
                name: "batch_delete_emails",
                description: "Permanently deletes multiple emails in batches",
                inputSchema: zodToJsonSchema(BatchDeleteEmailsSchema),
            },
            {
                name: "batch_read_emails",
                description: `Fetch multiple email bodies in bulk using Gmail's batch API.

Use this instead of calling read_email in a loop. Fetches up to 100 emails in 1-2 HTTP requests.

Returns JSON array of {id, threadId, subject, from, date, body} objects.
Use output_path to write results to a file (recommended for 20+ emails to avoid token overflow).

Pairs with search_emails: first search to get IDs, then batch_read to get bodies.`,
                inputSchema: zodToJsonSchema(BatchReadEmailsSchema),
            },
            {
                name: "create_label",
                description: "Creates a new Gmail label",
                inputSchema: zodToJsonSchema(CreateLabelSchema),
            },
            {
                name: "update_label",
                description: "Updates an existing Gmail label",
                inputSchema: zodToJsonSchema(UpdateLabelSchema),
            },
            {
                name: "delete_label",
                description: "Deletes a Gmail label",
                inputSchema: zodToJsonSchema(DeleteLabelSchema),
            },
            {
                name: "get_or_create_label",
                description: "Gets an existing label by name or creates it if it doesn't exist",
                inputSchema: zodToJsonSchema(GetOrCreateLabelSchema),
            },
            {
                name: "create_filter",
                description: "Creates a new Gmail filter with custom criteria and actions",
                inputSchema: zodToJsonSchema(CreateFilterSchema),
            },
            {
                name: "list_filters",
                description: "Retrieves all Gmail filters",
                inputSchema: zodToJsonSchema(ListFiltersSchema),
            },
            {
                name: "get_filter",
                description: "Gets details of a specific Gmail filter",
                inputSchema: zodToJsonSchema(GetFilterSchema),
            },
            {
                name: "delete_filter",
                description: "Deletes a Gmail filter",
                inputSchema: zodToJsonSchema(DeleteFilterSchema),
            },
            {
                name: "create_filter_from_template",
                description: "Creates a filter using a pre-defined template for common scenarios",
                inputSchema: zodToJsonSchema(CreateFilterFromTemplateSchema),
            },
            {
                name: "download_attachment",
                description: "Downloads an email attachment to a specified location",
                inputSchema: zodToJsonSchema(DownloadAttachmentSchema),
            },
            {
                name: "get_thread_messages",
                description: `Retrieves all messages in a thread by thread ID.

Use this tool when you need to find all related messages in a conversation thread - including replies, forwards, and the original message.

Common use case: After reading an email with read_email (which returns Thread ID), use this tool to get all messages in that thread, then use batch_modify_emails to archive them all.

Returns: Message ID, subject, sender, and date for each message in the thread.`,
                inputSchema: zodToJsonSchema(GetThreadMessagesSchema),
            },
            {
                name: "archive_thread",
                description: `Archives an entire email thread by removing the INBOX label from all messages.

Use this tool when you want to archive an email conversation. This is the PREFERRED way to archive emails because it handles all messages in the thread atomically.

How it works:
- Gets all messages in the thread
- Removes the INBOX label from each message
- Returns success status with count of archived messages

Get the threadId from read_email output (shown as "Thread ID: ...").`,
                inputSchema: zodToJsonSchema(ArchiveThreadSchema),
            },
        ],
    }))

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;

        async function handleEmailAction(action: "send" | "draft", validatedArgs: any) {
            let message: string;
            
            try {
                // Check if we have attachments
                if (validatedArgs.attachments && validatedArgs.attachments.length > 0) {
                    // Use Nodemailer to create properly formatted RFC822 message
                    message = await createEmailWithNodemailer(validatedArgs);
                    
                    if (action === "send") {
                        const encodedMessage = Buffer.from(message).toString('base64')
                            .replace(/\+/g, '-')
                            .replace(/\//g, '_')
                            .replace(/=+$/, '');

                        const result = await gmail.users.messages.send({
                            userId: 'me',
                            requestBody: {
                                raw: encodedMessage,
                                ...(validatedArgs.threadId && { threadId: validatedArgs.threadId })
                            }
                        });
                        
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `Email sent successfully with ID: ${result.data.id}`,
                                },
                            ],
                        };
                    } else {
                        // For drafts with attachments, use the raw message
                        const encodedMessage = Buffer.from(message).toString('base64')
                            .replace(/\+/g, '-')
                            .replace(/\//g, '_')
                            .replace(/=+$/, '');
                        
                        const messageRequest = {
                            raw: encodedMessage,
                            ...(validatedArgs.threadId && { threadId: validatedArgs.threadId })
                        };
                        
                        const response = await gmail.users.drafts.create({
                            userId: 'me',
                            requestBody: {
                                message: messageRequest,
                            },
                        });
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `Email draft created successfully with ID: ${response.data.id}`,
                                },
                            ],
                        };
                    }
                } else {
                    // For emails without attachments, use the existing simple method
                    message = createEmailMessage(validatedArgs);
                    
                    const encodedMessage = Buffer.from(message).toString('base64')
                        .replace(/\+/g, '-')
                        .replace(/\//g, '_')
                        .replace(/=+$/, '');

                    // Define the type for messageRequest
                    interface GmailMessageRequest {
                        raw: string;
                        threadId?: string;
                    }

                    const messageRequest: GmailMessageRequest = {
                        raw: encodedMessage,
                    };

                    // Add threadId if specified
                    if (validatedArgs.threadId) {
                        messageRequest.threadId = validatedArgs.threadId;
                    }

                    if (action === "send") {
                        const response = await gmail.users.messages.send({
                            userId: 'me',
                            requestBody: messageRequest,
                        });
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `Email sent successfully with ID: ${response.data.id}`,
                                },
                            ],
                        };
                    } else {
                        const response = await gmail.users.drafts.create({
                            userId: 'me',
                            requestBody: {
                                message: messageRequest,
                        },
                        });
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `Email draft created successfully with ID: ${response.data.id}`,
                                },
                            ],
                        };
                    }
                }
            } catch (error: any) {
                // Log attachment-related errors for debugging
                if (validatedArgs.attachments && validatedArgs.attachments.length > 0) {
                    console.error(`Failed to send email with ${validatedArgs.attachments.length} attachments:`, error.message);
                }
                throw error;
            }
        }

        // Helper function to process operations in batches
        async function processBatches<T, U>(
            items: T[],
            batchSize: number,
            processFn: (batch: T[]) => Promise<U[]>
        ): Promise<{ successes: U[], failures: { item: T, error: Error }[] }> {
            const successes: U[] = [];
            const failures: { item: T, error: Error }[] = [];
            
            // Process in batches
            for (let i = 0; i < items.length; i += batchSize) {
                const batch = items.slice(i, i + batchSize);
                try {
                    const results = await processFn(batch);
                    successes.push(...results);
                } catch (error) {
                    // If batch fails, try individual items
                    for (const item of batch) {
                        try {
                            const result = await processFn([item]);
                            successes.push(...result);
                        } catch (itemError) {
                            failures.push({ item, error: itemError as Error });
                        }
                    }
                }
            }
            
            return { successes, failures };
        }

        try {
            switch (name) {
                case "send_email":
                case "draft_email": {
                    const validatedArgs = SendEmailSchema.parse(args);
                    const action = name === "send_email" ? "send" : "draft";
                    return await handleEmailAction(action, validatedArgs);
                }

                case "read_email": {
                    const validatedArgs = ReadEmailSchema.parse(args);
                    const response = await gmail.users.messages.get({
                        userId: 'me',
                        id: validatedArgs.messageId,
                        format: 'full',
                    });

                    const headers = response.data.payload?.headers || [];
                    const subject = headers.find(h => h.name?.toLowerCase() === 'subject')?.value || '';
                    const from = headers.find(h => h.name?.toLowerCase() === 'from')?.value || '';
                    const to = headers.find(h => h.name?.toLowerCase() === 'to')?.value || '';
                    const date = headers.find(h => h.name?.toLowerCase() === 'date')?.value || '';
                    const threadId = response.data.threadId || '';

                    // Extract body text using shared helper
                    const body = getBodyText(response.data.payload as GmailMessagePart || {});

                    // Get attachment information
                    const attachments: EmailAttachment[] = [];
                    const processAttachmentParts = (part: GmailMessagePart, path: string = '') => {
                        if (part.body && part.body.attachmentId) {
                            const filename = part.filename || `attachment-${part.body.attachmentId}`;
                            attachments.push({
                                id: part.body.attachmentId,
                                filename: filename,
                                mimeType: part.mimeType || 'application/octet-stream',
                                size: part.body.size || 0
                            });
                        }

                        if (part.parts) {
                            part.parts.forEach((subpart: GmailMessagePart) =>
                                processAttachmentParts(subpart, `${path}/parts`)
                            );
                        }
                    };

                    if (response.data.payload) {
                        processAttachmentParts(response.data.payload as GmailMessagePart);
                    }

                    // Add attachment info to output if any are present
                    const attachmentInfo = attachments.length > 0 ?
                        `\n\nAttachments (${attachments.length}):\n` +
                        attachments.map(a => `- ${a.filename} (${a.mimeType}, ${Math.round(a.size/1024)} KB, ID: ${a.id})`).join('\n') : '';

                    return {
                        content: [
                            {
                                type: "text",
                                text: `Thread ID: ${threadId}\nSubject: ${subject}\nFrom: ${from}\nTo: ${to}\nDate: ${date}\n\n${body}${attachmentInfo}`,
                            },
                        ],
                    };
                }

                case "batch_read_emails": {
                    const validatedArgs = BatchReadEmailsSchema.parse(args);
                    const messageIds = validatedArgs.messageIds;
                    const maxBodyLength = validatedArgs.maxBodyLength ?? 5000;

                    if (messageIds.length === 0) {
                        return { content: [{ type: "text", text: "No message IDs provided." }] };
                    }
                    if (messageIds.length > 100) {
                        return { content: [{ type: "text", text: "Maximum 100 message IDs per call." }] };
                    }

                    const allResults: Array<{
                        id: string; threadId: string; subject: string;
                        from: string; date: string; body: string; truncated: boolean;
                    }> = [];
                    const failures: Array<{ id: string; error: string }> = [];

                    // Helper to execute a single batch HTTP request and parse results
                    async function executeBatch(batchIds: string[]): Promise<{
                        successes: typeof allResults;
                        retryIds: string[];
                        hardFailures: typeof failures;
                    }> {
                        const { body: requestBody, boundary: requestBoundary } = buildBatchRequest(batchIds);

                        // Use oauth2Client.request() directly — the googleapis JS client
                        // doesn't expose a batch endpoint, so raw HTTP is the only option.
                        const response = await oauth2Client.request({
                            url: 'https://www.googleapis.com/batch/gmail/v1',
                            method: 'POST',
                            headers: { 'Content-Type': `multipart/mixed; boundary=${requestBoundary}` },
                            body: requestBody,
                            responseType: 'text',
                        });

                        const responseContentType = (response.headers instanceof Headers ? response.headers.get('content-type') : response.headers['content-type']) as string || '';
                        const boundaryMatch = responseContentType.match(/boundary=(.+)/);
                        if (!boundaryMatch) {
                            throw new Error('Could not extract boundary from batch response Content-Type header');
                        }
                        const responseBoundary = boundaryMatch[1].trim();

                        const responseText = typeof response.data === 'string'
                            ? response.data
                            : String(response.data);

                        const parsed = parseBatchResponse(responseText, responseBoundary);
                        const successIds = new Set<string>();
                        const successes: typeof allResults = [];
                        const retryIds: string[] = [];
                        const hardFailures: typeof failures = [];

                        for (const item of parsed) {
                            if (item.error) {
                                if (item.error.includes('429')) {
                                    retryIds.push(item.id);
                                } else {
                                    hardFailures.push({ id: item.id, error: item.error });
                                }
                                continue;
                            }
                            const msgData = item.data;
                            successIds.add(msgData.id);
                            const headers = msgData.payload?.headers || [];
                            const subject = headers.find((h: any) => h.name?.toLowerCase() === 'subject')?.value || '';
                            const from = headers.find((h: any) => h.name?.toLowerCase() === 'from')?.value || '';
                            const date = headers.find((h: any) => h.name?.toLowerCase() === 'date')?.value || '';

                            const rawBody = getBodyText(msgData.payload as GmailMessagePart || {}, maxBodyLength);
                            const truncated = maxBodyLength > 0 && rawBody.includes('[Truncated:');

                            successes.push({
                                id: msgData.id,
                                threadId: msgData.threadId || '',
                                subject, from, date,
                                body: rawBody,
                                truncated,
                            });
                        }

                        // Any IDs not in successes or hardFailures and not already in retryIds
                        // were 429'd but had "unknown" IDs — diff against input to find them
                        const unknownRetries = retryIds.filter(id => id === 'unknown').length;
                        const knownIds = new Set([...successIds, ...hardFailures.map(f => f.id), ...retryIds.filter(id => id !== 'unknown')]);
                        const missingIds = batchIds.filter(id => !knownIds.has(id));
                        const finalRetryIds = [...retryIds.filter(id => id !== 'unknown'), ...missingIds];

                        return { successes, retryIds: finalRetryIds, hardFailures };
                    }

                    // Process in batches of 25 to stay under Gmail's per-user concurrent request limit.
                    const BATCH_SIZE = 25;
                    let pendingIds = [...messageIds];
                    const MAX_RETRIES = 2;

                    for (let attempt = 0; attempt <= MAX_RETRIES && pendingIds.length > 0; attempt++) {
                        if (attempt > 0) {
                            // Wait before retrying (exponential backoff: 2s, 4s)
                            await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
                        }

                        const retryNextRound: string[] = [];

                        for (let i = 0; i < pendingIds.length; i += BATCH_SIZE) {
                            const batchIds = pendingIds.slice(i, i + BATCH_SIZE);
                            const { successes, retryIds, hardFailures } = await executeBatch(batchIds);

                            allResults.push(...successes);
                            failures.push(...hardFailures);
                            retryNextRound.push(...retryIds);

                            // Brief delay between batches to avoid hitting concurrency limits
                            if (i + BATCH_SIZE < pendingIds.length) {
                                await new Promise(resolve => setTimeout(resolve, 500));
                            }
                        }

                        pendingIds = retryNextRound;
                    }

                    // Any remaining pendingIds after all retries are final failures
                    for (const id of pendingIds) {
                        failures.push({ id, error: 'Rate limited after retries' });
                    }

                    if (validatedArgs.output_path) {
                        fs.writeFileSync(validatedArgs.output_path, JSON.stringify(allResults, null, 2));
                        return {
                            content: [{
                                type: "text",
                                text: `Batch read complete. ${allResults.length} emails written to ${validatedArgs.output_path}` +
                                    (failures.length > 0 ? `\n${failures.length} failed: ${failures.map(f => `${f.id} (${f.error})`).join(', ')}` : ''),
                            }],
                        };
                    }

                    return {
                        content: [{
                            type: "text",
                            text: JSON.stringify(allResults, null, 2) +
                                (failures.length > 0 ? `\n\nFailed (${failures.length}): ${failures.map(f => `${f.id} (${f.error})`).join(', ')}` : ''),
                        }],
                    };
                }

                case "search_emails": {
                    const validatedArgs = SearchEmailsSchema.parse(args);
                    const response = await gmail.users.messages.list({
                        userId: 'me',
                        q: validatedArgs.query,
                        maxResults: validatedArgs.maxResults || 10,
                    });

                    const messages = response.data.messages || [];
                    const results = await Promise.all(
                        messages.map(async (msg) => {
                            const detail = await gmail.users.messages.get({
                                userId: 'me',
                                id: msg.id!,
                                format: 'metadata',
                                metadataHeaders: ['Subject', 'From', 'Date'],
                            });
                            const headers = detail.data.payload?.headers || [];
                            return {
                                id: msg.id,
                                subject: headers.find(h => h.name === 'Subject')?.value || '',
                                from: headers.find(h => h.name === 'From')?.value || '',
                                date: headers.find(h => h.name === 'Date')?.value || '',
                            };
                        })
                    );

                    return {
                        content: [
                            {
                                type: "text",
                                text: results.map(r =>
                                    `ID: ${r.id}\nSubject: ${r.subject}\nFrom: ${r.from}\nDate: ${r.date}\n`
                                ).join('\n'),
                            },
                        ],
                    };
                }

                // Updated implementation for the modify_email handler
                case "modify_email": {
                    const validatedArgs = ModifyEmailSchema.parse(args);
                    
                    // Prepare request body
                    const requestBody: any = {};
                    
                    if (validatedArgs.labelIds) {
                        requestBody.addLabelIds = validatedArgs.labelIds;
                    }
                    
                    if (validatedArgs.addLabelIds) {
                        requestBody.addLabelIds = validatedArgs.addLabelIds;
                    }
                    
                    if (validatedArgs.removeLabelIds) {
                        requestBody.removeLabelIds = validatedArgs.removeLabelIds;
                    }
                    
                    await gmail.users.messages.modify({
                        userId: 'me',
                        id: validatedArgs.messageId,
                        requestBody: requestBody,
                    });

                    return {
                        content: [
                            {
                                type: "text",
                                text: `Email ${validatedArgs.messageId} labels updated successfully`,
                            },
                        ],
                    };
                }

                case "delete_email": {
                    const validatedArgs = DeleteEmailSchema.parse(args);
                    await gmail.users.messages.delete({
                        userId: 'me',
                        id: validatedArgs.messageId,
                    });

                    return {
                        content: [
                            {
                                type: "text",
                                text: `Email ${validatedArgs.messageId} deleted successfully`,
                            },
                        ],
                    };
                }

                case "list_email_labels": {
                    const labelResults = await listLabels(gmail);
                    const systemLabels = labelResults.system;
                    const userLabels = labelResults.user;

                    return {
                        content: [
                            {
                                type: "text",
                                text: `Found ${labelResults.count.total} labels (${labelResults.count.system} system, ${labelResults.count.user} user):\n\n` +
                                    "System Labels:\n" +
                                    systemLabels.map((l: GmailLabel) => `ID: ${l.id}\nName: ${l.name}\n`).join('\n') +
                                    "\nUser Labels:\n" +
                                    userLabels.map((l: GmailLabel) => `ID: ${l.id}\nName: ${l.name}\n`).join('\n')
                            },
                        ],
                    };
                }

                case "batch_modify_emails": {
                    const validatedArgs = BatchModifyEmailsSchema.parse(args);
                    const messageIds = validatedArgs.messageIds;
                    const batchSize = validatedArgs.batchSize || 50;
                    
                    // Prepare request body
                    const requestBody: any = {};
                    
                    if (validatedArgs.addLabelIds) {
                        requestBody.addLabelIds = validatedArgs.addLabelIds;
                    }
                    
                    if (validatedArgs.removeLabelIds) {
                        requestBody.removeLabelIds = validatedArgs.removeLabelIds;
                    }

                    // Process messages in batches
                    const { successes, failures } = await processBatches(
                        messageIds,
                        batchSize,
                        async (batch) => {
                            const results = await Promise.all(
                                batch.map(async (messageId) => {
                                    const result = await gmail.users.messages.modify({
                                        userId: 'me',
                                        id: messageId,
                                        requestBody: requestBody,
                                    });
                                    return { messageId, success: true };
                                })
                            );
                            return results;
                        }
                    );

                    // Generate summary of the operation
                    const successCount = successes.length;
                    const failureCount = failures.length;
                    
                    let resultText = `Batch label modification complete.\n`;
                    resultText += `Successfully processed: ${successCount} messages\n`;
                    
                    if (failureCount > 0) {
                        resultText += `Failed to process: ${failureCount} messages\n\n`;
                        resultText += `Failed message IDs:\n`;
                        resultText += failures.map(f => `- ${(f.item as string).substring(0, 16)}... (${f.error.message})`).join('\n');
                    }

                    return {
                        content: [
                            {
                                type: "text",
                                text: resultText,
                            },
                        ],
                    };
                }

                case "batch_delete_emails": {
                    const validatedArgs = BatchDeleteEmailsSchema.parse(args);
                    const messageIds = validatedArgs.messageIds;
                    const batchSize = validatedArgs.batchSize || 50;

                    // Process messages in batches
                    const { successes, failures } = await processBatches(
                        messageIds,
                        batchSize,
                        async (batch) => {
                            const results = await Promise.all(
                                batch.map(async (messageId) => {
                                    await gmail.users.messages.delete({
                                        userId: 'me',
                                        id: messageId,
                                    });
                                    return { messageId, success: true };
                                })
                            );
                            return results;
                        }
                    );

                    // Generate summary of the operation
                    const successCount = successes.length;
                    const failureCount = failures.length;
                    
                    let resultText = `Batch delete operation complete.\n`;
                    resultText += `Successfully deleted: ${successCount} messages\n`;
                    
                    if (failureCount > 0) {
                        resultText += `Failed to delete: ${failureCount} messages\n\n`;
                        resultText += `Failed message IDs:\n`;
                        resultText += failures.map(f => `- ${(f.item as string).substring(0, 16)}... (${f.error.message})`).join('\n');
                    }

                    return {
                        content: [
                            {
                                type: "text",
                                text: resultText,
                            },
                        ],
                    };
                }

                // New label management handlers
                case "create_label": {
                    const validatedArgs = CreateLabelSchema.parse(args);
                    const result = await createLabel(gmail, validatedArgs.name, {
                        messageListVisibility: validatedArgs.messageListVisibility,
                        labelListVisibility: validatedArgs.labelListVisibility,
                    });

                    return {
                        content: [
                            {
                                type: "text",
                                text: `Label created successfully:\nID: ${result.id}\nName: ${result.name}\nType: ${result.type}`,
                            },
                        ],
                    };
                }

                case "update_label": {
                    const validatedArgs = UpdateLabelSchema.parse(args);
                    
                    // Prepare request body with only the fields that were provided
                    const updates: any = {};
                    if (validatedArgs.name) updates.name = validatedArgs.name;
                    if (validatedArgs.messageListVisibility) updates.messageListVisibility = validatedArgs.messageListVisibility;
                    if (validatedArgs.labelListVisibility) updates.labelListVisibility = validatedArgs.labelListVisibility;
                    
                    const result = await updateLabel(gmail, validatedArgs.id, updates);

                    return {
                        content: [
                            {
                                type: "text",
                                text: `Label updated successfully:\nID: ${result.id}\nName: ${result.name}\nType: ${result.type}`,
                            },
                        ],
                    };
                }

                case "delete_label": {
                    const validatedArgs = DeleteLabelSchema.parse(args);
                    const result = await deleteLabel(gmail, validatedArgs.id);

                    return {
                        content: [
                            {
                                type: "text",
                                text: result.message,
                            },
                        ],
                    };
                }

                case "get_or_create_label": {
                    const validatedArgs = GetOrCreateLabelSchema.parse(args);
                    const result = await getOrCreateLabel(gmail, validatedArgs.name, {
                        messageListVisibility: validatedArgs.messageListVisibility,
                        labelListVisibility: validatedArgs.labelListVisibility,
                    });

                    const action = result.type === 'user' && result.name === validatedArgs.name ? 'found existing' : 'created new';
                    
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Successfully ${action} label:\nID: ${result.id}\nName: ${result.name}\nType: ${result.type}`,
                            },
                        ],
                    };
                }


                // Filter management handlers
                case "create_filter": {
                    const validatedArgs = CreateFilterSchema.parse(args);
                    const result = await createFilter(gmail, validatedArgs.criteria, validatedArgs.action);

                    // Format criteria for display
                    const criteriaText = Object.entries(validatedArgs.criteria)
                        .filter(([_, value]) => value !== undefined)
                        .map(([key, value]) => `${key}: ${value}`)
                        .join(', ');

                    // Format actions for display
                    const actionText = Object.entries(validatedArgs.action)
                        .filter(([_, value]) => value !== undefined && (Array.isArray(value) ? value.length > 0 : true))
                        .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`)
                        .join(', ');

                    return {
                        content: [
                            {
                                type: "text",
                                text: `Filter created successfully:\nID: ${result.id}\nCriteria: ${criteriaText}\nActions: ${actionText}`,
                            },
                        ],
                    };
                }

                case "list_filters": {
                    const result = await listFilters(gmail);
                    const filters = result.filters;

                    if (filters.length === 0) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: "No filters found.",
                                },
                            ],
                        };
                    }

                    const filtersText = filters.map((filter: any) => {
                        const criteriaEntries = Object.entries(filter.criteria || {})
                            .filter(([_, value]) => value !== undefined)
                            .map(([key, value]) => `${key}: ${value}`)
                            .join(', ');
                        
                        const actionEntries = Object.entries(filter.action || {})
                            .filter(([_, value]) => value !== undefined && (Array.isArray(value) ? value.length > 0 : true))
                            .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`)
                            .join(', ');

                        return `ID: ${filter.id}\nCriteria: ${criteriaEntries}\nActions: ${actionEntries}\n`;
                    }).join('\n');

                    return {
                        content: [
                            {
                                type: "text",
                                text: `Found ${result.count} filters:\n\n${filtersText}`,
                            },
                        ],
                    };
                }

                case "get_filter": {
                    const validatedArgs = GetFilterSchema.parse(args);
                    const result = await getFilter(gmail, validatedArgs.filterId);

                    const criteriaText = Object.entries(result.criteria || {})
                        .filter(([_, value]) => value !== undefined)
                        .map(([key, value]) => `${key}: ${value}`)
                        .join(', ');
                    
                    const actionText = Object.entries(result.action || {})
                        .filter(([_, value]) => value !== undefined && (Array.isArray(value) ? value.length > 0 : true))
                        .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`)
                        .join(', ');

                    return {
                        content: [
                            {
                                type: "text",
                                text: `Filter details:\nID: ${result.id}\nCriteria: ${criteriaText}\nActions: ${actionText}`,
                            },
                        ],
                    };
                }

                case "delete_filter": {
                    const validatedArgs = DeleteFilterSchema.parse(args);
                    const result = await deleteFilter(gmail, validatedArgs.filterId);

                    return {
                        content: [
                            {
                                type: "text",
                                text: result.message,
                            },
                        ],
                    };
                }

                case "create_filter_from_template": {
                    const validatedArgs = CreateFilterFromTemplateSchema.parse(args);
                    const template = validatedArgs.template;
                    const params = validatedArgs.parameters;

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

                    return {
                        content: [
                            {
                                type: "text",
                                text: `Filter created from template '${template}':\nID: ${result.id}\nTemplate used: ${template}`,
                            },
                        ],
                    };
                }
                case "download_attachment": {
                    const validatedArgs = DownloadAttachmentSchema.parse(args);
                    
                    try {
                        // Get the attachment data from Gmail API
                        const attachmentResponse = await gmail.users.messages.attachments.get({
                            userId: 'me',
                            messageId: validatedArgs.messageId,
                            id: validatedArgs.attachmentId,
                        });

                        if (!attachmentResponse.data.data) {
                            throw new Error('No attachment data received');
                        }

                        // Decode the base64 data
                        const data = attachmentResponse.data.data;
                        const buffer = Buffer.from(data, 'base64url');

                        // Determine save path and filename
                        const savePath = validatedArgs.savePath || process.cwd();
                        let filename = validatedArgs.filename;
                        
                        if (!filename) {
                            // Get original filename from message if not provided
                            const messageResponse = await gmail.users.messages.get({
                                userId: 'me',
                                id: validatedArgs.messageId,
                                format: 'full',
                            });
                            
                            // Find the attachment part to get original filename
                            const findAttachment = (part: any): string | null => {
                                if (part.body && part.body.attachmentId === validatedArgs.attachmentId) {
                                    return part.filename || `attachment-${validatedArgs.attachmentId}`;
                                }
                                if (part.parts) {
                                    for (const subpart of part.parts) {
                                        const found = findAttachment(subpart);
                                        if (found) return found;
                                    }
                                }
                                return null;
                            };
                            
                            filename = findAttachment(messageResponse.data.payload) || `attachment-${validatedArgs.attachmentId}`;
                        }

                        // Ensure save directory exists
                        if (!fs.existsSync(savePath)) {
                            fs.mkdirSync(savePath, { recursive: true });
                        }

                        // Write file
                        const fullPath = path.join(savePath, filename);
                        fs.writeFileSync(fullPath, buffer);

                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `Attachment downloaded successfully:\nFile: ${filename}\nSize: ${buffer.length} bytes\nSaved to: ${fullPath}`,
                                },
                            ],
                        };
                    } catch (error: any) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `Failed to download attachment: ${error.message}`,
                                },
                            ],
                        };
                    }
                }

                case "get_thread_messages": {
                    const validatedArgs = GetThreadMessagesSchema.parse(args);

                    try {
                        const response = await gmail.users.threads.get({
                            userId: 'me',
                            id: validatedArgs.threadId,
                            format: 'metadata',
                            metadataHeaders: ['Subject', 'From', 'Date'],
                        });

                        const messages = response.data.messages || [];

                        if (messages.length === 0) {
                            return {
                                content: [{
                                    type: "text",
                                    text: `Thread ${validatedArgs.threadId} exists but contains no messages.`,
                                }],
                            };
                        }

                        const results = messages.map((msg) => {
                            const headers = msg.payload?.headers || [];
                            return {
                                id: msg.id,
                                threadId: msg.threadId,
                                subject: headers.find(h => h.name === 'Subject')?.value || '',
                                from: headers.find(h => h.name === 'From')?.value || '',
                                date: headers.find(h => h.name === 'Date')?.value || '',
                            };
                        });

                        return {
                            content: [{
                                type: "text",
                                text: `Found ${results.length} message(s) in thread:\n\n` +
                                    results.map(r =>
                                        `ID: ${r.id}\nSubject: ${r.subject}\nFrom: ${r.from}\nDate: ${r.date}`
                                    ).join('\n\n'),
                            }],
                        };
                    } catch (error: any) {
                        if (error.code === 404) {
                            return {
                                content: [{
                                    type: "text",
                                    text: `Thread ${validatedArgs.threadId} not found. Verify the thread ID is correct (get it from read_email output).`,
                                }],
                                isError: true,
                            };
                        }
                        throw error;  // Re-throw for global error handler
                    }
                }

                case "archive_thread": {
                    const validatedArgs = ArchiveThreadSchema.parse(args);

                    try {
                        // Step 1: Get all messages in the thread
                        const threadResponse = await gmail.users.threads.get({
                            userId: 'me',
                            id: validatedArgs.threadId,
                            format: 'minimal',  // We only need message IDs
                        });

                        const messages = threadResponse.data.messages || [];

                        if (messages.length === 0) {
                            return {
                                content: [{
                                    type: "text",
                                    text: `Thread ${validatedArgs.threadId} exists but contains no messages.`,
                                }],
                            };
                        }

                        const messageIds = messages.map(msg => msg.id!).filter(Boolean);

                        // Step 2: Remove INBOX label from all messages
                        const results = await Promise.all(
                            messageIds.map(async (messageId) => {
                                try {
                                    await gmail.users.messages.modify({
                                        userId: 'me',
                                        id: messageId,
                                        requestBody: {
                                            removeLabelIds: ['INBOX'],
                                        },
                                    });
                                    return { messageId, success: true };
                                } catch (error: any) {
                                    return { messageId, success: false, error: error.message };
                                }
                            })
                        );

                        const succeeded = results.filter(r => r.success);
                        const failed = results.filter(r => !r.success);

                        let resultText = `Thread archived successfully.\n`;
                        resultText += `Messages archived: ${succeeded.length}\n`;
                        resultText += `Message IDs: ${succeeded.map(r => r.messageId).join(', ')}`;

                        if (failed.length > 0) {
                            resultText += `\n\nFailed to archive ${failed.length} message(s):\n`;
                            resultText += failed.map(r => `- ${r.messageId}: ${(r as any).error}`).join('\n');
                        }

                        return {
                            content: [{
                                type: "text",
                                text: resultText,
                            }],
                        };
                    } catch (error: any) {
                        if (error.code === 404) {
                            return {
                                content: [{
                                    type: "text",
                                    text: `Thread ${validatedArgs.threadId} not found. Verify the thread ID is correct (get it from read_email output).`,
                                }],
                                isError: true,
                            };
                        }
                        throw error;
                    }
                }

                default:
                    throw new Error(`Unknown tool: ${name}`);
            }
        } catch (error: any) {
            return {
                content: [
                    {
                        type: "text",
                        text: `Error: ${error.message}`,
                    },
                ],
            };
        }
    });

    const transport = new StdioServerTransport();
    server.connect(transport);
}

main().catch((error) => {
    console.error('Server error:', error);
    process.exit(1);
});
