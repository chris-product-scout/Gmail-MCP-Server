import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFilter, listFilters, getFilter, deleteFilter, filterTemplates } from '../dist/filter-manager.js';

function mockGmail(overrides = {}) {
    return {
        users: {
            settings: {
                filters: {
                    create: overrides.create || (async () => ({ data: {} })),
                    list: overrides.list || (async () => ({ data: { filters: [] } })),
                    get: overrides.get || (async () => ({ data: {} })),
                    delete: overrides.delete || (async () => ({})),
                },
            },
        },
    };
}

describe('createFilter', () => {
    it('returns response.data on success', async () => {
        const gmail = mockGmail({
            create: async () => ({ data: { id: 'f1', criteria: { from: 'a@b.com' } } }),
        });
        const result = await createFilter(gmail, { from: 'a@b.com' }, { addLabelIds: ['L1'] });
        assert.equal(result.id, 'f1');
    });

    it('throws on 400 invalid criteria', async () => {
        const gmail = mockGmail({
            create: async () => { const e = new Error('Bad Request'); e.code = 400; throw e; },
        });
        await assert.rejects(
            () => createFilter(gmail, {}, {}),
            { message: /Invalid filter criteria/ }
        );
    });
});

describe('listFilters', () => {
    it('returns filters and count', async () => {
        const gmail = mockGmail({
            list: async () => ({ data: { filters: [{ id: 'f1' }, { id: 'f2' }] } }),
        });
        const result = await listFilters(gmail);
        assert.equal(result.count, 2);
        assert.equal(result.filters.length, 2);
    });
});

describe('getFilter', () => {
    it('returns filter on success', async () => {
        const gmail = mockGmail({
            get: async () => ({ data: { id: 'f1', criteria: { from: 'x@y.com' } } }),
        });
        const result = await getFilter(gmail, 'f1');
        assert.equal(result.id, 'f1');
    });

    it('throws on 404', async () => {
        const gmail = mockGmail({
            get: async () => { const e = new Error('Not found'); e.code = 404; throw e; },
        });
        await assert.rejects(
            () => getFilter(gmail, 'missing'),
            { message: /not found/i }
        );
    });
});

describe('deleteFilter', () => {
    it('returns success message', async () => {
        const gmail = mockGmail({ delete: async () => ({}) });
        const result = await deleteFilter(gmail, 'f1');
        assert.equal(result.success, true);
        assert.ok(result.message.includes('f1'));
    });

    it('throws on 404', async () => {
        const gmail = mockGmail({
            delete: async () => { const e = new Error('Not found'); e.code = 404; throw e; },
        });
        await assert.rejects(
            () => deleteFilter(gmail, 'missing'),
            { message: /not found/i }
        );
    });
});

describe('filterTemplates', () => {
    it('fromSender creates correct shape', () => {
        const t = filterTemplates.fromSender('a@b.com', ['L1'], true);
        assert.equal(t.criteria.from, 'a@b.com');
        assert.deepEqual(t.action.addLabelIds, ['L1']);
        assert.deepEqual(t.action.removeLabelIds, ['INBOX']);
    });

    it('withSubject creates correct shape', () => {
        const t = filterTemplates.withSubject('urgent', ['L2'], true);
        assert.equal(t.criteria.subject, 'urgent');
        assert.deepEqual(t.action.removeLabelIds, ['UNREAD']);
    });

    it('withAttachments creates correct shape', () => {
        const t = filterTemplates.withAttachments(['L3']);
        assert.equal(t.criteria.hasAttachment, true);
        assert.deepEqual(t.action.addLabelIds, ['L3']);
    });

    it('largeEmails uses sizeComparison larger', () => {
        const t = filterTemplates.largeEmails(1000000, ['L4']);
        assert.equal(t.criteria.size, 1000000);
        assert.equal(t.criteria.sizeComparison, 'larger');
    });

    it('containingText wraps text in quotes', () => {
        const t = filterTemplates.containingText('hello world', ['L5']);
        assert.equal(t.criteria.query, '"hello world"');
    });

    it('mailingList formats query correctly', () => {
        const t = filterTemplates.mailingList('dev-team', ['L6'], true);
        assert.ok(t.criteria.query.includes('list:dev-team'));
        assert.ok(t.criteria.query.includes('subject:[dev-team]'));
        assert.deepEqual(t.action.removeLabelIds, ['INBOX']);
    });
});
