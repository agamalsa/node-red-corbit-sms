'use strict';

const assert = require('node:assert/strict');
const helper = require('node-red-node-test-helper');
const corbitNode = require('../nodes/corbit-sms.js');
const catchNode = require('@node-red/nodes/core/common/25-catch.js');
const { createMockApi, ok, fail } = require('./mock-api');

helper.init(require.resolve('node-red'));

describe('corbit-sms node', function () {
	this.timeout(10000);
	const api = createMockApi();
	let baseUrl;

	before(async () => {
		baseUrl = await api.start();
	});
	after(() => api.stop());
	beforeEach((done) => {
		api.reset();
		helper.startServer(done);
	});
	afterEach((done) => {
		helper.unload().then(() => helper.stopServer(done));
	});

	function flow(props) {
		return [
			{ id: 'acc', type: 'corbit-sms-account', name: 'Test account', baseUrl },
			{ id: 'n1', type: 'corbit-sms', account: 'acc', wires: [['out']], ...props },
			{ id: 'out', type: 'helper' },
			{ id: 'c1', type: 'catch', scope: ['n1'], wires: [['caught']] },
			{ id: 'caught', type: 'helper' },
		];
	}
	const creds = { acc: { apiToken: 'tok-1' } };

	function load(props, credentials = creds) {
		return helper.load([corbitNode, catchNode], flow(props), credentials);
	}

	it('loads with default settings', async () => {
		await load({ operation: 'send' });
		const n = helper.getNode('n1');
		assert.equal(n.operation, 'send');
		assert.equal(helper.getNode('acc').baseUrl, baseUrl);
	});

	it('sends msg.payload to msg.to with the chosen sender', async () => {
		api.reply(ok({ status: 'Success', data: { message: { id: 'm1', status: 'pending' } } }));
		await load({ operation: 'send', sender: 'OT.SA', senderType: 'str' });
		const got = new Promise((resolve) => helper.getNode('out').on('input', resolve));
		helper.getNode('n1').receive({ payload: 4821, to: '0501234567', keep: 'me' });
		const msg = await got;
		assert.deepEqual(msg.payload, { messageId: 'm1', status: 'pending', to: '966501234567', senderName: 'OT.SA' });
		assert.equal(msg.keep, 'me');
		assert.equal(api.requests[0].headers.authorization, 'Bearer tok-1');
		assert.deepEqual(api.requests[0].body, { senderName: 'OT.SA', number: '966501234567', messageBody: '4821', sendAtOption: 'NOW' });
		assert.equal(api.requests[0].headers['x-allow-duplicate'], undefined);
		assert.equal(api.requests[0].headers['idempotency-key'], undefined);
	});

	it('uses msg.sender when the sender field is empty, plus duplicate and idempotency options', async () => {
		api.reply(ok({ status: 'Success', data: { message: { id: 'm2', status: 'pending' } } }));
		await load({ operation: 'send', sender: '', senderType: 'str', allowDuplicate: true, idempotencyKey: 'key', idempotencyKeyType: 'msg' });
		const got = new Promise((resolve) => helper.getNode('out').on('input', resolve));
		helper.getNode('n1').receive({ payload: 'hi', to: '966501234567', sender: 'MSG.SENDER', key: 'abc' });
		await got;
		assert.equal(api.requests[0].body.senderName, 'MSG.SENDER');
		assert.equal(api.requests[0].headers['x-allow-duplicate'], 'true');
		assert.equal(api.requests[0].headers['idempotency-key'], 'abc');
	});

	it('msg.allowDuplicate overrides the checkbox both ways', async () => {
		api.reply(ok({ status: 'Success', data: { message: { id: 'a' } } }), ok({ status: 'Success', data: { message: { id: 'b' } } }));
		await load({ operation: 'send', sender: 'A', allowDuplicate: true });
		const out = helper.getNode('out');
		let p = new Promise((resolve) => out.once('input', resolve));
		helper.getNode('n1').receive({ payload: 'hi', to: '966501234567', allowDuplicate: false });
		await p;
		p = new Promise((resolve) => out.once('input', resolve));
		helper.getNode('n1').receive({ payload: 'hi', to: '966501234567' });
		await p;
		assert.equal(api.requests[0].headers['x-allow-duplicate'], undefined);
		assert.equal(api.requests[1].headers['x-allow-duplicate'], 'true');
	});

	it('sends bulk from an array in msg.numbers', async () => {
		api.reply(ok({ status: 'Success', data: { message: { id: 'b1', status: 'pending' } } }));
		await load({ operation: 'sendBulk', sender: 'A' });
		const got = new Promise((resolve) => helper.getNode('out').on('input', resolve));
		helper.getNode('n1').receive({ payload: 'hi', numbers: ['0501234567', '966551234567'] });
		const msg = await got;
		assert.equal(msg.payload.recipients, 2);
		assert.deepEqual(api.requests[0].body.numbers, ['966501234567', '966551234567']);
	});

	it('reads status, report, balance and sender names', async () => {
		api.reply(
			ok({ status: 'Success', data: { status: 'delivered' } }),
			ok({ jobId: 'j', msgs: [{ destAddress: '1', status: 'delivered' }, { destAddress: '2', status: 'failed' }] }),
			ok({ status: 'Success', data: { balance: 635 } }),
			ok({ status: 'Success', data: [{ name: 'A', status: 'approved' }, { name: 'B', status: 'expired' }] }),
		);
		const run = async (props, input) => {
			await helper.unload();
			await load(props);
			const got = new Promise((resolve) => helper.getNode('out').on('input', resolve));
			helper.getNode('n1').receive(input);
			return (await got).payload;
		};
		assert.deepEqual(await run({ operation: 'getStatus' }, { messageId: 'm1' }), { messageId: 'm1', status: 'delivered' });
		assert.equal((await run({ operation: 'getReport', messageId: 'payload.messageId', messageIdType: 'msg' }, { payload: { messageId: 'm2' } })).recipients.length, 2);
		assert.deepEqual(await run({ operation: 'getBalance' }, {}), { balance: 635 });
		assert.deepEqual(await run({ operation: 'getSenderNames', senderStatus: 'approved' }, {}), [{ name: 'A', status: 'approved' }]);
	});

	it('reports API errors to a Catch node with msg.corbitError', async () => {
		api.reply(fail(409, { status: 'Error', message: 'Duplicate request blocked', code: 'DUPLICATE' }));
		await load({ operation: 'send', sender: 'A' });
		let sent = false;
		helper.getNode('out').on('input', () => (sent = true));
		const caught = new Promise((resolve) => helper.getNode('caught').on('input', resolve));
		helper.getNode('n1').receive({ payload: 'hi', to: '966501234567' });
		const msg = await caught;
		assert.match(msg.error.message, /^Duplicate request blocked\. The same text/);
		assert.equal(msg.corbitError.code, 'DUPLICATE');
		assert.equal(msg.corbitError.statusCode, 409);
		assert.equal(sent, false);
	});

	it('stops before any request when the input is invalid', async () => {
		await load({ operation: 'send', sender: 'A' });
		const caught = new Promise((resolve) => helper.getNode('caught').on('input', resolve));
		helper.getNode('n1').receive({ payload: 'hi', to: '01001234567' });
		const msg = await caught;
		assert.match(msg.error.message, /not valid: "01001234567"/);
		assert.equal(api.requests.length, 0);
	});

	it('reports a missing token and a missing account', async () => {
		await load({ operation: 'getBalance' }, { acc: {} });
		let caught = new Promise((resolve) => helper.getNode('caught').on('input', resolve));
		helper.getNode('n1').receive({});
		assert.match((await caught).error.message, /API token is missing/);
		await helper.unload();
		await helper.load(
			[corbitNode, catchNode],
			[
				{ id: 'n1', type: 'corbit-sms', account: 'nope', operation: 'getBalance', wires: [[]] },
				{ id: 'c1', type: 'catch', scope: ['n1'], wires: [['caught']] },
				{ id: 'caught', type: 'helper' },
			],
		);
		caught = new Promise((resolve) => helper.getNode('caught').on('input', resolve));
		helper.getNode('n1').receive({});
		assert.match((await caught).error.message, /No Corbit SMS account is selected/);
		assert.equal(api.requests.length, 0);
	});

	it('editor routes: sender list and connection test, never echoing the token', async () => {
		await load({ operation: 'send' });
		api.reply(ok({ status: 'Success', data: [{ name: 'Z', status: 'approved' }, { name: 'A', status: 'approved' }, { name: 'P', status: 'pending' }] }));
		let res = await helper.request().post('/corbit-sms/senders').send({ account: 'acc', apiToken: '__PWRD__' });
		assert.equal(res.status, 200);
		assert.deepEqual(res.body, { senders: ['A', 'Z'] });
		assert.equal(api.requests[0].headers.authorization, 'Bearer tok-1');

		api.reply(ok({ status: 'Success', data: { balance: 9 } }));
		res = await helper.request().post('/corbit-sms/test').send({ account: 'new-unsaved', apiToken: 'typed-token', baseUrl });
		assert.deepEqual(res.body, { balance: 9 });
		assert.equal(api.requests[1].headers.authorization, 'Bearer typed-token');

		api.reply(fail(401, { message: 'Unauthenticated.' }));
		res = await helper.request().post('/corbit-sms/test').send({ account: 'acc', apiToken: 'bad-token-xyz', baseUrl });
		assert.equal(res.status, 400);
		assert.equal(res.body.error, 'Unauthenticated.');
		assert.match(res.body.hint, /token was rejected/);
		assert.doesNotMatch(JSON.stringify(res.body), /bad-token-xyz/);

		res = await helper.request().post('/corbit-sms/test').send({});
		assert.equal(res.status, 400);
		assert.match(res.body.error, /API token is missing/);
	});

	it('editor routes never send a stored token to another address or for another node type', async () => {
		await load({ operation: 'send' });
		api.reply(ok({ status: 'Success', data: { balance: 1 } }));
		// A stored token always goes to its own deployed base URL, whatever the request says.
		let res = await helper.request().post('/corbit-sms/test').send({ account: 'acc', baseUrl: 'https://attacker.example' });
		assert.deepEqual(res.body, { balance: 1 });
		assert.equal(api.requests.length, 1);
		// Another node's id is refused.
		res = await helper.request().post('/corbit-sms/test').send({ account: 'n1' });
		assert.equal(res.status, 400);
		assert.match(res.body.error, /API token is missing/);
		// A typed token must use https (or this machine).
		res = await helper.request().post('/corbit-sms/test').send({ apiToken: 'typed', baseUrl: 'http://example.com' });
		assert.match(res.body.error, /base URL is not valid/);
		assert.equal(api.requests.length, 1);
	});

	it('clears an old msg.corbitError on success and masks the number in the status', async () => {
		api.reply(ok({ status: 'Success', data: { message: { id: 'm9', status: 'pending' } } }));
		await load({ operation: 'send', sender: 'A' });
		const n1 = helper.getNode('n1');
		const statuses = [];
		const origStatus = n1.status.bind(n1);
		n1.status = (s) => { statuses.push(s); return origStatus(s); };
		const got = new Promise((resolve) => helper.getNode('out').on('input', resolve));
		n1.receive({ payload: 'hi', to: '966501234567', corbitError: { message: 'old' } });
		const msg = await got;
		assert.equal(msg.corbitError, undefined);
		assert.equal(statuses.at(-1).text, 'sent to …4567');
	});

	it('stops quietly when the node is closed during a request', async () => {
		await load({ operation: 'getBalance' });
		// The mock answers immediately, so close before the reply is handled.
		let sent = false;
		helper.getNode('out').on('input', () => (sent = true));
		helper.getNode('n1').receive({});
		await helper.unload();
		await new Promise((r) => setTimeout(r, 100));
		assert.equal(sent, false);
	});
});
