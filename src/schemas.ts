import { z } from "zod";

/** Adds an optional `account` parameter to a Zod raw shape */
export function withAccount<T extends Record<string, z.ZodTypeAny>>(shape: T) {
    return {
        ...shape,
        account: z.string().optional().describe("Account to use (e.g., 'work'). Optional if only one account."),
    };
}

export const SendEmailSchema = z.object({
    to: z.array(z.string()).describe("List of recipient email addresses"),
    subject: z.string().describe("Email subject"),
    body: z.string().describe("Email body content (used for text/plain or when htmlBody not provided)"),
    htmlBody: z.string().optional().describe("HTML version of the email body"),
    mimeType: z.enum(['text/plain', 'text/html', 'multipart/alternative']).optional().default('text/plain').describe("Email content type"),
    cc: z.array(z.string()).optional().describe("List of CC recipients"),
    bcc: z.array(z.string()).optional().describe("List of BCC recipients"),
    threadId: z.string().optional().describe("Thread ID to file the message into. Optional: when inReplyTo is set this is auto-derived from the replied-to message, so you normally don't need to pass it for replies."),
    inReplyTo: z.string().optional().describe("Gmail message ID being replied to (the server resolves the RFC 2822 Message-ID header automatically). When set, auto-populates To/CC with reply-all recipients unless replyAll is false."),
    replyAll: z.boolean().optional().default(true).describe("When replying (inReplyTo set), auto-populate To/CC with all original recipients. Set to false to only reply to sender. Default: true."),
    attachments: z.array(z.string()).optional().describe("List of file paths to attach to the email"),
});

export const ReadEmailSchema = z.object({
    messageId: z.string().describe("ID of the email message to retrieve"),
});

export const SearchEmailsSchema = z.object({
    query: z.string().describe("Gmail search query (e.g., 'from:example@gmail.com')"),
    maxResults: z.number().optional().describe("Maximum number of results to return"),
});

export const ModifyEmailSchema = z.object({
    messageId: z.string().describe("ID of the email message to modify"),
    labelIds: z.array(z.string()).optional().describe("List of label IDs to apply"),
    addLabelIds: z.array(z.string()).optional().describe("List of label IDs to add to the message"),
    removeLabelIds: z.array(z.string()).optional().describe("List of label IDs to remove from the message"),
});

export const DeleteEmailSchema = z.object({
    messageId: z.string().describe("ID of the email message to delete"),
});

export const ListEmailLabelsSchema = z.object({}).describe("Retrieves all available Gmail labels");

export const CreateLabelSchema = z.object({
    name: z.string().describe("Name for the new label"),
    messageListVisibility: z.enum(['show', 'hide']).optional().describe("Whether to show or hide the label in the message list"),
    labelListVisibility: z.enum(['labelShow', 'labelShowIfUnread', 'labelHide']).optional().describe("Visibility of the label in the label list"),
}).describe("Creates a new Gmail label");

export const UpdateLabelSchema = z.object({
    id: z.string().describe("ID of the label to update"),
    name: z.string().optional().describe("New name for the label"),
    messageListVisibility: z.enum(['show', 'hide']).optional().describe("Whether to show or hide the label in the message list"),
    labelListVisibility: z.enum(['labelShow', 'labelShowIfUnread', 'labelHide']).optional().describe("Visibility of the label in the label list"),
}).describe("Updates an existing Gmail label");

export const DeleteLabelSchema = z.object({
    id: z.string().describe("ID of the label to delete"),
}).describe("Deletes a Gmail label");

export const GetOrCreateLabelSchema = z.object({
    name: z.string().describe("Name of the label to get or create"),
    messageListVisibility: z.enum(['show', 'hide']).optional().describe("Whether to show or hide the label in the message list"),
    labelListVisibility: z.enum(['labelShow', 'labelShowIfUnread', 'labelHide']).optional().describe("Visibility of the label in the label list"),
}).describe("Gets an existing label by name or creates it if it doesn't exist");

export const BatchModifyEmailsSchema = z.object({
    messageIds: z.array(z.string()).describe("List of message IDs to modify"),
    addLabelIds: z.array(z.string()).optional().describe("List of label IDs to add to all messages"),
    removeLabelIds: z.array(z.string()).optional().describe("List of label IDs to remove from all messages"),
    batchSize: z.number().optional().default(1000).describe("Number of messages to process in each batch (default: 1000, Gmail API max)"),
});

export const BatchDeleteEmailsSchema = z.object({
    messageIds: z.array(z.string()).describe("List of message IDs to delete"),
    batchSize: z.number().optional().default(1000).describe("Number of messages to process in each batch (default: 1000, Gmail API max)"),
});

export const BatchReadEmailsSchema = z.object({
    messageIds: z.array(z.string()).describe("List of message IDs to fetch"),
    maxBodyLength: z.coerce.number().optional().default(5000)
        .describe("Max characters of body text per email (default 5000). Set to 0 for no limit."),
    output_path: z.string().optional()
        .describe("File path to write JSON results. When provided, writes to file and returns only metadata."),
});

export const CreateFilterSchema = z.object({
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

export const ListFiltersSchema = z.object({}).describe("Retrieves all Gmail filters");

export const GetFilterSchema = z.object({
    filterId: z.string().describe("ID of the filter to retrieve")
}).describe("Gets details of a specific Gmail filter");

export const DeleteFilterSchema = z.object({
    filterId: z.string().describe("ID of the filter to delete")
}).describe("Deletes a Gmail filter");

export const CreateFilterFromTemplateSchema = z.object({
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

export const DownloadAttachmentSchema = z.object({
    messageId: z.string().describe("ID of the email message containing the attachment"),
    attachmentId: z.string().describe("ID of the attachment to download"),
    filename: z.string().optional().describe("Filename to save the attachment as (if not provided, uses original filename)"),
    savePath: z.string().optional().describe("Directory path to save the attachment (defaults to current directory)"),
});

export const GetThreadMessagesSchema = z.object({
    threadId: z.string().describe("ID of the thread to retrieve all messages from"),
});

export const ArchiveThreadSchema = z.object({
    threadId: z.string().describe("ID of the thread to archive (get this from read_email output)"),
});

export const GetDraftsSchema = z.object({
    draftId: z.string().optional().describe("ID of a specific draft to retrieve with full content. Omit to list all drafts with metadata (subject, to, date)."),
    maxResults: z.number().optional().describe("Max drafts to return when listing (default 100). Ignored when draftId is provided."),
    pageToken: z.string().optional().describe("Pagination token from a previous list response. Ignored when draftId is provided."),
    q: z.string().optional().describe("Gmail search query to filter drafts when listing (e.g. 'to:john@example.com'). Ignored when draftId is provided."),
}).describe("Get drafts. With draftId: returns full content of that draft. Without draftId: lists all drafts with subject, recipients, and date metadata.");

export const UpdateDraftSchema = z.object({
    draftId: z.string().describe("ID of the draft to update (get this from get_drafts)"),
    to: z.array(z.string()).describe("List of recipient email addresses"),
    subject: z.string().describe("Email subject"),
    body: z.string().describe("Email body content (plain text)"),
    htmlBody: z.string().optional().describe("HTML version of the email body"),
    mimeType: z.enum(['text/plain', 'text/html', 'multipart/alternative']).optional().default('text/plain').describe("Email content type"),
    cc: z.array(z.string()).optional().describe("List of CC recipients"),
    bcc: z.array(z.string()).optional().describe("List of BCC recipients"),
    threadId: z.string().optional().describe("Thread ID to preserve threading. Optional: auto-derived from inReplyTo when that's set."),
    inReplyTo: z.string().optional().describe("Gmail message ID being replied to (the server resolves the RFC 2822 Message-ID header automatically). When set, auto-populates To/CC with reply-all recipients unless replyAll is false."),
    replyAll: z.boolean().optional().default(true).describe("When replying (inReplyTo set), auto-populate To/CC with all original recipients. Set to false to only reply to sender. Default: true."),
    attachments: z.array(z.string()).optional().describe("List of file paths to attach. Because update fully overwrites the draft, you MUST re-list every attachment you want to keep — any attachment not included here is dropped."),
}).describe("Replace an existing draft's content. All message fields are required since this fully overwrites the draft, including attachments (re-list them or they are dropped).");

export const DeleteDraftSchema = z.object({
    draftId: z.string().describe("ID of the draft to permanently delete (get this from get_drafts)"),
}).describe("Permanently and immediately deletes a draft. Cannot be undone.");

export const SendDraftSchema = z.object({
    draftId: z.string().describe("ID of the draft to send (get this from get_drafts)"),
}).describe("Sends an existing draft to the recipients in its To, Cc, and Bcc headers.");

/** Map of all schema names for validation/testing */
export const ALL_SCHEMAS = {
    SendEmailSchema,
    ReadEmailSchema,
    SearchEmailsSchema,
    ModifyEmailSchema,
    DeleteEmailSchema,
    ListEmailLabelsSchema,
    CreateLabelSchema,
    UpdateLabelSchema,
    DeleteLabelSchema,
    GetOrCreateLabelSchema,
    BatchModifyEmailsSchema,
    BatchDeleteEmailsSchema,
    BatchReadEmailsSchema,
    CreateFilterSchema,
    ListFiltersSchema,
    GetFilterSchema,
    DeleteFilterSchema,
    CreateFilterFromTemplateSchema,
    DownloadAttachmentSchema,
    GetThreadMessagesSchema,
    ArchiveThreadSchema,
    GetDraftsSchema,
    UpdateDraftSchema,
    DeleteDraftSchema,
    SendDraftSchema,
} as const;
