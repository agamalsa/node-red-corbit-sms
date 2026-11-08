'use strict';

const assert = require('node:assert/strict');
const corbit = require('../nodes/lib/corbit');
const { createMockApi, ok, fail } = require('./mock-api');

describe('lib: normalizeNumber', () => {
	it('accepts international and Saudi local forms', () => {
		assert.equal(corbit.normalizeNumber('+966 50 123 4567'), '966501234567');
		assert.equal(corbit.normalizeNumber('00966501234567'), '966501234567');
		assert.equal(corbit.normalizeNumber('0501234567'), '966501234567');
		assert.equal(corbit.normalizeNumber('501234567'), '966501234567');
		assert.equal(corbit.normalizeNumber(966501234567), '966501234567');
		assert.equal(corbit.normalizeNumber('+20 100 123 4567'), '201001234567');
	});
	it('rejects local numbers of other countries and junk', () => {
		assert.equal(corbit.normalizeNumber('01001234567'), undefined);
		assert.equal(corbit.normalizeNumber('123'), undefined);
		assert.equal(corbit.normalizeNumber(''), undefined);
		assert.equal(corbit.normalizeNumber(null), undefined);
		assert.equal(corbit.normalizeNumber({ a: 1 }), undefined);
		assert.equal(corbit.normalizeNumber(['966501234567']), undefined);
	});
});

describe('lib: splitNumbers and checkMessage', () => {
	it('splits text and arrays', () => {
		assert.deepEqual(corbit.splitNumbers('1, 2;3\n4\r\n'), ['1', '2', '3', '4']);
		assert.deepEqual(corbit.splitNumbers(['1', ['2, 3'], 4]), ['1', '2', '3', 4]);
		assert.deepEqual(corbit.splitNumbers(undefined), []);
	});
	it('converts numbers and checks length', () => {
		assert.equal(corbit.checkMessage(4821), '4821');
		assert.equal(corbit.checkMessage('x'.repeat(1600)).length, 1600);
		assert.throws(() => corbit.checkMessage('x'.repeat(1601)), /1601 characters; the limit is 1600/);
		assert.throws(() => corbit.checkMessage('  '), /message is empty/);
		assert.throws(() => corbit.checkMessage(undefined), /message is empty/);
		assert.throws(() => corbit.checkMessage({ text: 'hi' }), /must be text/);
	});
});

describe('lib: API calls', () => {
	const api = createMockApi();
	let conn;
	before(async () => {
		conn = { token: 'test-token', baseUrl: (await api.start()) + '/' };
	});
	after(() => api.stop());
	beforeEach(() => api.reset());

	it('sends one SMS with the documented body and headers', async () => {
		api.reply(ok({ status: 'Success', data: { message: { id: 'abc', status: 'pending' } } }));
		const r = await corbit.sendSms(conn, { sender: ' OT.SA ', to: '0501234567', message: 4821, idempotencyKey: 'k1', allowDuplicate: true });
		assert.deepEqual(r, { messageId: 'abc', status: 'pending', to: '966501234567', senderName: 'OT.SA' });
		const q = api.requests[0];
		assert.equal(q.method, 'POST');
		assert.equal(q.url, '/api/v1/send');
		assert.equal(q.headers.authorization, 'Bearer test-token');
		assert.equal(q.headers['idempotency-key'], 'k1');
		assert.equal(q.headers['x-allow-duplicate'], 'true');
		assert.deepEqual(q.body, { senderName: 'OT.SA', number: '966501234567', messageBody: '4821', sendAtOption: 'NOW' });
	});

	it('does not call the API when a field is invalid', async () => {
		await assert.rejects(corbit.sendSms(conn, { sender: '', to: '966501234567', message: 'x' }), /No sender name/);
		await assert.rejects(corbit.sendSms(conn, { sender: 'A', to: '0100123456', message: 'x' }), /not valid: "0100123456"/);
		await assert.rejects(corbit.sendSms(conn, { sender: 'A', to: '966501234567', message: '' }), /message is empty/);
		await assert.rejects(corbit.sendSms(conn, { sender: 'A', to: '966501234567', message: 'x', idempotencyKey: 'k'.repeat(256) }), /256 characters/);
		await assert.rejects(corbit.sendSms({ ...conn, token: '' }, { sender: 'A', to: '966501234567', message: 'x' }), /API token is missing/);
		await assert.rejects(corbit.sendSms({ ...conn, baseUrl: 'api.corbit.sa' }, { sender: 'A', to: '966501234567', message: 'x' }), /base URL is not valid/);
		assert.equal(api.requests.length, 0);
	});

	it('sends bulk with unique normalized numbers and rejects invalid ones', async () => {
		api.reply(ok({ status: 'Success', data: { message: { id: 'b1', status: 'pending' } } }));
		const r = await corbit.sendBulkSms(conn, { sender: 'A', numbers: '0501234567, 966501234567\n+966551234567', message: 'hi' });
		assert.deepEqual(r.numbers, ['966501234567', '966551234567']);
		assert.equal(r.recipients, 2);
		assert.deepEqual(api.requests[0].body, { senderName: 'A', numbers: ['966501234567', '966551234567'], messageBody: 'hi', sendAtOption: 'Now' });
		await assert.rejects(corbit.sendBulkSms(conn, { sender: 'A', numbers: ['966501234567', 'x', '0100'], message: 'hi' }), /Invalid mobile numbers: x, 0100/);
		await assert.rejects(corbit.sendBulkSms(conn, { sender: 'A', numbers: [], message: 'hi' }), /list of numbers is empty/);
		assert.equal(api.requests.length, 1);
	});

	it('turns API errors into clear messages with hints', async () => {
		const send = () => corbit.sendSms(conn, { sender: 'A', to: '966501234567', message: 'x' });
		api.reply(fail(402, { status: 'Error', message: 'Insufficient balance (0).', code: 'INSUFFICIENT_BALANCE' }));
		await assert.rejects(send(), (e) => e.message === 'Insufficient balance (0).' && /Top up/.test(e.hint) && e.code === 'INSUFFICIENT_BALANCE' && e.statusCode === 402);
		api.reply(fail(401, { message: 'Unauthenticated.' }));
		await assert.rejects(send(), (e) => /token was rejected/.test(e.hint));
		api.reply(fail(429, { status: 'Error', message: 'Rate limit', code: 'RATE_LIMIT' }, { 'Retry-After': '30' }));
		await assert.rejects(send(), (e) => /Try again in 30 seconds/.test(e.hint) && e.retryAfter === '30');
		api.reply(fail(409, { status: 'Error', message: 'Duplicate', code: 'DUPLICATE' }));
		await assert.rejects(send(), (e) => /allowDuplicate/.test(e.hint));
		api.reply(ok({ status: 'Error', message: 'Sender not approved' }));
		await assert.rejects(send(), /Sender not approved/);
		api.reply({ status: 502, body: '<html>Bad gateway</html>' });
		await assert.rejects(send(), /Corbit SMS returned HTTP 502/);
		api.reply({ status: 500, body: '' });
		await assert.rejects(send(), /Corbit SMS returned HTTP 500/);
	});

	it('reports network failures', async () => {
		await assert.rejects(
			corbit.getBalance({ token: 't', baseUrl: 'http://127.0.0.1:1' }),
			(e) => /Could not reach Corbit SMS/.test(e.message) && /internet connection/.test(e.hint),
		);
	});

	it('gets status, report, balance', async () => {
		api.reply(
			ok({ status: 'Success', data: { status: 'delivered' } }),
			ok({ jobId: 'j1', msgs: [{ destAddress: '966501234567', status: 'delivered' }] }),
			ok({ status: 'Success', data: { balance: 183 } }),
		);
		assert.deepEqual(await corbit.getStatus(conn, ' m/1 '), { messageId: 'm/1', status: 'delivered' });
		assert.equal(api.requests[0].url, '/api/v1/message-status/m%2F1');
		const rep = await corbit.getReport(conn, 'm2');
		assert.deepEqual(rep, { messageId: 'm2', jobId: 'j1', recipients: [{ destAddress: '966501234567', status: 'delivered' }] });
		assert.deepEqual(await corbit.getBalance(conn), { balance: 183 });
		await assert.rejects(corbit.getStatus(conn, ''), /message ID is empty/);
		await assert.rejects(corbit.getReport(conn, { id: 1 }), /message ID is empty/);
	});

	it('pages sender names and stops safely', async () => {
		const names = (from, n, status = 'approved') => Array.from({ length: n }, (_, i) => ({ name: `S${from + i}`, status }));
		api.reply(
			ok({ status: 'Success', data: names(0, 50), pagination: { total: 60, per_page: 50, current_page: 1 } }),
			ok({ status: 'Success', data: names(50, 10, 'expired'), pagination: { total: 60, per_page: 50, current_page: 2 } }),
		);
		const all = await corbit.listSenderNames(conn, 'all');
		assert.equal(all.length, 60);
		assert.equal(api.requests[1].url, '/api/v1/sendernames?per_page=50&page=2');

		// The API ignores the page parameter: stop instead of looping.
		api.reset();
		api.reply(
			ok({ status: 'Success', data: names(0, 50), pagination: { total: 500, per_page: 50, current_page: 1 } }),
			ok({ status: 'Success', data: names(0, 50), pagination: { total: 500, per_page: 50, current_page: 1 } }),
		);
		assert.equal((await corbit.listSenderNames(conn, 'all')).length, 50);
		assert.equal(api.requests.length, 2);

		api.reset();
		api.reply(ok({ status: 'Success', data: [{ name: 'B', status: 'Approved' }, { name: 'A', status: 'approved' }, { name: 'C', status: 'pending' }, { name: 'A', status: 'approved' }] }));
		assert.deepEqual(await corbit.approvedSenderNames(conn), ['A', 'B']);

		api.reset();
		api.reply(ok({ status: 'Success', data: [{ name: 'B', status: 'approved' }, { name: 'C', status: 'pending' }] }));
		assert.deepEqual((await corbit.listSenderNames(conn, 'pending')).map((s) => s.name), ['C']);
	});
});

describe('lib: review fixes', () => {
	const api = createMockApi();
	let base;
	before(async () => {
		base = await api.start();
	});
	after(() => api.stop());
	beforeEach(() => api.reset());

	it('rejects numbers that could become a wrong number', () => {
		for (const bad of ['9.66501E+11', '966501234567.0', '+966 50 123 4567 ext 12', 966501234567.5, -966501234567, 'abc966501234567', '+0501234567']) {
			assert.equal(corbit.normalizeNumber(bad), undefined, String(bad));
		}
		assert.equal(corbit.normalizeNumber('+966 (0) 50 123 4567'), '966501234567');
		assert.equal(corbit.normalizeNumber('9660501234567'), '966501234567');
		assert.equal(corbit.normalizeNumber('٠٥٠١٢٣٤٥٦٧'), '966501234567');
		assert.equal(corbit.normalizeNumber('۹۶۶۵۰۱۲۳۴۵۶۷'), '966501234567');
		assert.equal(corbit.normalizeNumber('(050) 123-4567'), '966501234567');
	});

	it('never puts the token in an error and rejects tokens with line breaks', async () => {
		const conn = { token: 'abc\ndef-SECRET', baseUrl: base };
		await assert.rejects(corbit.getBalance(conn), (e) => /line breaks/.test(e.message) && !/SECRET/.test(e.message + (e.hint || '')));
		await assert.rejects(corbit.getBalance({ token: 'tok', baseUrl: 'http://127.0.0.1:1' }), (e) => !/tok/.test(e.message.replace('token', '')));
		assert.equal(api.requests.length, 0);
	});

	it('requires https except on this machine', () => {
		assert.equal(corbit.cleanBaseUrl('https://api.corbit.sa/'), 'https://api.corbit.sa');
		assert.equal(corbit.cleanBaseUrl('http://localhost:8413'), 'http://localhost:8413');
		assert.throws(() => corbit.cleanBaseUrl('http://api.corbit.sa'), /not valid/);
		assert.throws(() => corbit.cleanBaseUrl('https://user:pw@api.corbit.sa'), /not valid/);
		assert.throws(() => corbit.cleanBaseUrl('ftp://x'), /not valid/);
	});

	it('warns that a timed-out send may have gone out, and can be cancelled', async () => {
		const slowFetch = (url, init) =>
			new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
		await assert.rejects(
			corbit.sendSms({ token: 't', baseUrl: base, fetchImpl: slowFetch, timeoutMs: 50 }, { sender: 'A', to: '966501234567', message: 'x' }),
			(e) => /may have been sent/.test(e.message) && /before you send again/.test(e.hint),
		);
		await assert.rejects(corbit.getBalance({ token: 't', baseUrl: base, fetchImpl: slowFetch, timeoutMs: 50 }), (e) => !/may have been sent/.test(e.message));
		const c = new AbortController();
		const p = corbit.getBalance({ token: 't', baseUrl: base, fetchImpl: slowFetch, signal: c.signal });
		c.abort();
		await assert.rejects(p, /cancelled/);
		await assert.rejects(corbit.getBalance({ token: 't', baseUrl: base, fetchImpl: 'nope' }), /no fetch/);
	});

	it('does not echo a non-JSON body, and checks the idempotency key', async () => {
		api.reply({ status: 502, body: '<html>secret internal page</html>' });
		await assert.rejects(corbit.getBalance({ token: 't', baseUrl: base }), (e) => e.message === 'Corbit SMS returned HTTP 502');
		const conn = { token: 't', baseUrl: base };
		await assert.rejects(corbit.sendSms(conn, { sender: 'A', to: '966501234567', message: 'x', idempotencyKey: 'طلب-1' }), /English letters/);
		await assert.rejects(corbit.sendSms(conn, { sender: 'A', to: '966501234567', message: 'x', idempotencyKey: { a: 1 } }), /not an object/);
		assert.equal(corbit.maskNumber('966501234567'), '…4567');
	});
});

describe('lib: lists read like the Corbit SMS app', () => {
	it('splits on Arabic commas, tabs and spaces between numbers, keeps spaced numbers whole', () => {
		assert.deepEqual(corbit.splitNumbers('0501234567، 0551234567؛0561234567'), ['0501234567', '0551234567', '0561234567']);
		assert.deepEqual(corbit.splitNumbers('0501234567	0551234567'), ['0501234567', '0551234567']);
		assert.deepEqual(corbit.splitNumbers('0501234567 0509876543'), ['0501234567', '0509876543']);
		assert.deepEqual(corbit.splitNumbers('+966 50 123 4567, 05 0987 6543'), ['+966501234567', '0509876543']);
		assert.deepEqual(corbit.splitNumbers('+966 50 123 4567'), ['+966501234567']);
		assert.deepEqual(corbit.splitNumbers('٠٥٠١٢٣٤٥٦٧ 0551234567'), ['٠٥٠١٢٣٤٥٦٧', '0551234567']);
		// Extra words become their own invalid tokens, so a bulk send stops before sending.
		assert.deepEqual(corbit.splitNumbers('966501234567 ext 12'), ['966501234567', 'ext', '12']);
	});

	it('a bulk send with an Arabic-comma list sends to every number', async () => {
		const api = createMockApi();
		const base = await api.start();
		try {
			api.reply(ok({ status: 'Success', data: { message: { id: 'b', status: 'pending' } } }));
			const r = await corbit.sendBulkSms({ token: 't', baseUrl: base }, { sender: 'A', numbers: '0501234567، 0551234567 0561234567', message: 'hi' });
			assert.deepEqual(r.numbers, ['966501234567', '966551234567', '966561234567']);
			await assert.rejects(corbit.sendBulkSms({ token: 't', baseUrl: base }, { sender: 'A', numbers: '966501234567 ext 12', message: 'hi' }), /Invalid mobile numbers: ext, 12/);
			assert.equal(api.requests.length, 1);
		} finally {
			await api.stop();
		}
	});
});

