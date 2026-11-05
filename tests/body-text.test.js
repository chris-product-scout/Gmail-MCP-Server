import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getBodyText, extractEmailContent } from '../dist/body-text.js';

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64url');
const part = (mimeType, content) => ({ mimeType, body: { data: b64(content), size: content.length } });
const alt = (plain, html) => ({ mimeType: 'multipart/alternative', parts: [part('text/plain', plain), part('text/html', html)] });

// Normal person-to-person mail: both parts carry the same words.
const NORMAL_PLAIN = 'Hi Chris,\n\nThanks for the intro. Tuesday at 2pm works for me. I will send over the deck beforehand.\n\nBest,\nDana';
const NORMAL_HTML = '<div dir="ltr">Hi Chris,<br><br>Thanks for the intro. Tuesday at 2pm works for me. I will send over the deck beforehand.<br><br>Best,<br>Dana</div>';

// ATS-style stub: plain is a one-line notice, HTML holds the scorecard. Synthetic text.
const STUB_PLAIN = "Pat Doe,\n        Feedback was submitted for Sam Example's Product Manager application by Alex Reviewer.\n\nTo change your notification settings, go to <https://app.example-ats.com/settings/notifications>";
const STUB_HTML = `<html><body><p>Pat Doe,</p><p>Feedback was submitted for Sam Example's consideration for Product Manager application by Alex Reviewer</p>
<table><tr><td>Alex Reviewer</td></tr><tr><td>Onsite Interview</td></tr><tr><td>Overall Recommendation</td></tr><tr><td>3 - Yes</td></tr>
<tr><td>Feedback</td></tr><tr><td>Strong structured thinker. Walked through the pricing tradeoff clearly and asked sharp questions about rollout risk.
Weaker on metrics depth but recovered when prompted. Would want a follow-up on stakeholder management.</td></tr></table>
<p><a href="https://app.example-ats.com/feedback/1">View feedback here.</a></p></body></html>`;

// Short stub card: HTML text is barely longer than plain, but only HTML has the verdict.
const SHORT_HTML = `<p>Pat Doe,</p><p>Feedback was submitted for Sam Example's consideration for Product Manager application by Alex Reviewer</p>
<p>2</p><p>Alex Reviewer</p><p>Jam Session</p><p>Overall Recommendation</p><p>2 - No</p><p>Feedback</p><p>see other feedback</p><p>View feedback here.</p>`;

// Social-network-style: plain is long and URL-heavy, HTML text is shorter with some footer words.
const SOCIAL_PLAIN = 'Jordan accepted your invitation.\n\nView profile: https://social.example.com/in/jordan?trk=abc123def456\n\nExplore their network: https://social.example.com/search?trk=zzz999\n\n' + 'Unsubscribe: https://social.example.com/unsub?token=' + 'x'.repeat(400);
const SOCIAL_HTML = '<p>Jordan accepted your invitation</p><p>Explore their network</p><p>Footer: You are receiving notification emails. Learn why we included this. Help Center Privacy Terms</p>';

describe('getBodyText', () => {
    it('returns plain text unchanged for normal two-part mail', () => {
        assert.equal(getBodyText(alt(NORMAL_PLAIN, NORMAL_HTML)), NORMAL_PLAIN);
    });

    it('returns plain text when there is no HTML part', () => {
        assert.equal(getBodyText(part('text/plain', NORMAL_PLAIN)), NORMAL_PLAIN);
    });

    it('converts HTML when there is no plain part', () => {
        const body = getBodyText(part('text/html', NORMAL_HTML));
        assert.match(body, /Tuesday at 2pm works for me/);
        assert.doesNotMatch(body, /<div/);
    });

    it('uses the HTML text when the plain part is a stub notice', () => {
        const body = getBodyText(alt(STUB_PLAIN, STUB_HTML));
        assert.match(body, /Overall Recommendation/);
        assert.match(body, /3 - Yes/);
        assert.match(body, /Strong structured thinker/);
        assert.doesNotMatch(body, /<td>/);
    });

    it('uses the HTML text for a short card that is barely longer than the stub', () => {
        const body = getBodyText(alt(STUB_PLAIN, SHORT_HTML));
        assert.match(body, /Jam Session/);
        assert.match(body, /2 - No/);
    });

    it('keeps plain text when the HTML text is shorter, even with extra footer words', () => {
        assert.equal(getBodyText(alt(SOCIAL_PLAIN, SOCIAL_HTML)), SOCIAL_PLAIN);
    });

    it('keeps plain text when invisible preheader filler is all that makes the HTML longer', () => {
        const filler = '͏­ '.repeat(400);
        const html = `<div style="display:none">${filler}</div>` + NORMAL_HTML;
        assert.equal(getBodyText(alt(NORMAL_PLAIN, html)), NORMAL_PLAIN);
    });

    it('keeps a long, complete plain part even when the HTML adds a sponsor block', () => {
        const article = 'Every piece of software you buy promises a little more control over the business. '.repeat(40);
        const html = `<p>${article}</p><p>Sponsored: imagine your brand taking center stage in front of three hundred thousand engaged subscribers, makers and operators across commerce, retail and growth.</p><p>Forwarded this email? Subscribe here for more exclusive offers.</p>`;
        assert.equal(getBodyText(alt(article, html)), article);
    });

    it('strips invisible filler from HTML-only bodies', () => {
        const filler = '͏­‌ '.repeat(50);
        const body = getBodyText(part('text/html', `<p>Preview</p><div>${filler}</div><p>Real content here</p>`));
        assert.doesNotMatch(body, /[͏­‌]/);
        assert.match(body, /Real content here/);
    });

    it('truncates after choosing the HTML text', () => {
        const body = getBodyText(alt(STUB_PLAIN, STUB_HTML), 120);
        assert.match(body, /\[Truncated: \d+ characters omitted\]$/);
        assert.ok(body.startsWith('Pat Doe,'));
    });

    it('does not truncate when maxLength is 0', () => {
        const long = 'word '.repeat(20000);
        assert.equal(getBodyText(part('text/plain', long), 0), long);
    });

    it('returns an empty string for an empty payload', () => {
        assert.equal(getBodyText({}), '');
    });
});

describe('extractEmailContent', () => {
    it('collects plain and HTML from nested parts', () => {
        const payload = { mimeType: 'multipart/mixed', parts: [alt('hello', '<p>hello</p>'), { mimeType: 'application/pdf', filename: 'a.pdf', body: { attachmentId: 'x' } }] };
        assert.deepEqual(extractEmailContent(payload), { text: 'hello', html: '<p>hello</p>' });
    });
});
