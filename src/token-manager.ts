import { OAuth2Client } from 'google-auth-library';
import { google, gmail_v1 } from 'googleapis';
import fs from 'fs';

export interface AccountClients {
    oauth2Client: OAuth2Client;
    gmail: gmail_v1.Gmail;
}

interface OAuthKeys {
    client_id: string;
    client_secret: string;
}

type TokenData = Record<string, any>;
type MultiAccountTokens = Record<string, TokenData>;

// Write queue for serializing concurrent token refreshes
let writeQueue: Promise<void> = Promise.resolve();

function enqueueTokenWrite(operation: () => Promise<void>): Promise<void> {
    const pendingWrite = writeQueue
        .catch(() => undefined)
        .then(operation);
    writeQueue = pendingWrite
        .catch(error => {
            process.stderr.write(`Error writing token file: ${error instanceof Error ? error.message : error}\n`);
            throw error;
        })
        .catch(() => undefined);
    return pendingWrite;
}

export function loadMultiAccountTokens(tokenPath: string): MultiAccountTokens {
    const content = fs.readFileSync(tokenPath, 'utf-8');
    const parsed = JSON.parse(content);

    // Detect flat format (single account) by checking for token-specific fields
    if (parsed.refresh_token || parsed.access_token) {
        return { default: parsed };
    }

    return parsed as MultiAccountTokens;
}

function setupTokenRefreshForAccount(
    client: OAuth2Client,
    accountId: string,
    tokenPath: string
): void {
    client.on('tokens', (newTokens) => {
        enqueueTokenWrite(async () => {
            const multiAccountTokens = loadMultiAccountTokens(tokenPath);
            const currentTokens = multiAccountTokens[accountId] || {};
            multiAccountTokens[accountId] = {
                ...currentTokens,
                ...newTokens,
                refresh_token: newTokens.refresh_token || currentTokens.refresh_token,
            };
            fs.writeFileSync(tokenPath, JSON.stringify(multiAccountTokens, null, 2));
        });
    });
}

export function createAccountClients(
    tokens: MultiAccountTokens,
    oauthKeys: OAuthKeys,
    tokenPath: string
): Map<string, AccountClients> {
    const accounts = new Map<string, AccountClients>();

    for (const [accountId, tokenData] of Object.entries(tokens)) {
        const client = new OAuth2Client(oauthKeys.client_id, oauthKeys.client_secret);
        client.setCredentials(tokenData);
        setupTokenRefreshForAccount(client, accountId, tokenPath);

        const gmailClient = google.gmail({ version: 'v1', auth: client });
        accounts.set(accountId, { oauth2Client: client, gmail: gmailClient });
    }

    return accounts;
}

export function filterByAllowedAccounts(
    accounts: Map<string, AccountClients>
): Map<string, AccountClients> {
    const allowedAccountsEnv = process.env.ALLOWED_ACCOUNTS;
    if (!allowedAccountsEnv) return accounts;

    const allowed = allowedAccountsEnv
        .split(',')
        .map(a => a.trim().toLowerCase())
        .filter(a => a.length > 0);
    const filtered = new Map<string, AccountClients>();

    for (const name of allowed) {
        const client = accounts.get(name);
        if (client) {
            filtered.set(name, client);
        } else {
            process.stderr.write(`Warning: Allowed account '${name}' not found in token file\n`);
        }
    }

    const activeNames = Array.from(filtered.keys()).join(', ');
    process.stderr.write(`Account filter active: ${activeNames || '(none matched)'}\n`);
    return filtered;
}

export function resolveAccountId(
    accounts: Map<string, AccountClients>,
    requestedAccount?: string
): string {
    if (accounts.size === 0) {
        throw new Error('No authenticated accounts available');
    }

    if (requestedAccount) {
        const normalized = requestedAccount.toLowerCase();
        if (!accounts.has(normalized)) {
            const available = Array.from(accounts.keys()).join(', ');
            throw new Error(`Account "${normalized}" not found. Available: ${available}`);
        }
        return normalized;
    }

    // Auto-select if single account
    if (accounts.size === 1) {
        return accounts.keys().next().value!;
    }

    // Multiple accounts, no selection
    const available = Array.from(accounts.keys()).join(', ');
    throw new Error(`Multiple accounts available (${available}). You must specify the 'account' parameter.`);
}
