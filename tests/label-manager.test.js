import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createLabel, updateLabel, deleteLabel, listLabels, findLabelByName, getOrCreateLabel } from '../dist/label-manager.js';

// Helper to build a mock Gmail API object
function mockGmail(overrides = {}) {
    return {
        users: {
            labels: {
                create: overrides.create || (async () => ({ data: {} })),
                update: overrides.update || (async () => ({ data: {} })),
                delete: overrides.delete || (async () => ({})),
                get: overrides.get || (async () => ({ data: {} })),
                list: overrides.list || (async () => ({ data: { labels: [] } })),
            },
        },
    };
}

describe('createLabel', () => {
    it('returns response.data on success', async () => {
        const gmail = mockGmail({
            create: async () => ({ data: { id: 'Label_1', name: 'MyLabel' } }),
        });
        const result = await createLabel(gmail, 'MyLabel');
        assert.deepEqual(result, { id: 'Label_1', name: 'MyLabel' });
    });

    it('throws on duplicate label', async () => {
        const gmail = mockGmail({
            create: async () => { throw new Error('Label already exists'); },
        });
        await assert.rejects(
            () => createLabel(gmail, 'Dup'),
            { message: /Label "Dup" already exists/ }
        );
    });
});

describe('updateLabel', () => {
    it('returns response.data on success', async () => {
        const gmail = mockGmail({
            get: async () => ({ data: { id: 'L1', name: 'Old' } }),
            update: async () => ({ data: { id: 'L1', name: 'New' } }),
        });
        const result = await updateLabel(gmail, 'L1', { name: 'New' });
        assert.deepEqual(result, { id: 'L1', name: 'New' });
    });

    it('throws on 404', async () => {
        const gmail = mockGmail({
            get: async () => { const e = new Error('Not found'); e.code = 404; throw e; },
        });
        await assert.rejects(
            () => updateLabel(gmail, 'missing', { name: 'x' }),
            { message: /not found/i }
        );
    });
});

describe('deleteLabel', () => {
    it('returns success on valid user label', async () => {
        const gmail = mockGmail({
            get: async () => ({ data: { id: 'L1', name: 'ToDelete', type: 'user' } }),
            delete: async () => ({}),
        });
        const result = await deleteLabel(gmail, 'L1');
        assert.equal(result.success, true);
        assert.ok(result.message.includes('ToDelete'));
    });

    it('throws on system label', async () => {
        const gmail = mockGmail({
            get: async () => ({ data: { id: 'INBOX', name: 'INBOX', type: 'system' } }),
        });
        await assert.rejects(
            () => deleteLabel(gmail, 'INBOX'),
            { message: /Cannot delete system label/ }
        );
    });

    it('throws on 404', async () => {
        const gmail = mockGmail({
            get: async () => { const e = new Error('Not found'); e.code = 404; throw e; },
        });
        await assert.rejects(
            () => deleteLabel(gmail, 'missing'),
            { message: /not found/i }
        );
    });
});

describe('listLabels', () => {
    it('returns grouped structure with correct counts', async () => {
        const gmail = mockGmail({
            list: async () => ({
                data: {
                    labels: [
                        { id: 'INBOX', name: 'INBOX', type: 'system' },
                        { id: 'SENT', name: 'SENT', type: 'system' },
                        { id: 'L1', name: 'Custom', type: 'user' },
                    ],
                },
            }),
        });
        const result = await listLabels(gmail);
        assert.equal(result.count.total, 3);
        assert.equal(result.count.system, 2);
        assert.equal(result.count.user, 1);
        assert.equal(result.system.length, 2);
        assert.equal(result.user.length, 1);
    });
});

describe('findLabelByName', () => {
    const gmail = mockGmail({
        list: async () => ({
            data: {
                labels: [
                    { id: 'L1', name: 'MyLabel', type: 'user' },
                    { id: 'L2', name: 'Other', type: 'user' },
                ],
            },
        }),
    });

    it('finds label case-insensitively', async () => {
        const result = await findLabelByName(gmail, 'mylabel');
        assert.equal(result.id, 'L1');
    });

    it('returns null when not found', async () => {
        const result = await findLabelByName(gmail, 'nonexistent');
        assert.equal(result, null);
    });
});

describe('getOrCreateLabel', () => {
    it('returns existing label if found', async () => {
        const gmail = mockGmail({
            list: async () => ({
                data: { labels: [{ id: 'L1', name: 'Existing', type: 'user' }] },
            }),
        });
        const result = await getOrCreateLabel(gmail, 'Existing');
        assert.equal(result.id, 'L1');
    });

    it('creates new label if not found', async () => {
        const gmail = mockGmail({
            list: async () => ({ data: { labels: [] } }),
            create: async () => ({ data: { id: 'L_new', name: 'Brand New' } }),
        });
        const result = await getOrCreateLabel(gmail, 'Brand New');
        assert.equal(result.id, 'L_new');
    });
});
