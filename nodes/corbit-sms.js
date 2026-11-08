'use strict';

const corbit = require('./lib/corbit');

const OPERATIONS = ['send', 'sendBulk', 'getStatus', 'getReport', 'getBalance', 'getSenderNames'];
const SENDER_STATUSES = ['all', 'approved', 'pending', 'rejected', 'expired'];

module.exports = function (RED) {
	// ---------------------------------------------------------------- account
	function CorbitSmsAccountNode(config) {
		RED.nodes.createNode(this, config);
		this.name = config.name;
		this.baseUrl = config.baseUrl || corbit.DEFAULT_BASE_URL;
	}

	RED.nodes.registerType('corbit-sms-account', CorbitSmsAccountNode, {
		credentials: {
			apiToken: { type: 'password' },
		},
	});

	// ------------------------------------------------------------------- node
	function CorbitSmsNode(config) {
		RED.nodes.createNode(this, config);
		const node = this;
		node.account = RED.nodes.getNode(config.account);
		node.operation = OPERATIONS.includes(config.operation) ? config.operation : 'send';
		// Cancels the requests still running when the node is stopped or redeployed.
		const closing = new AbortController();

		if (!node.account) {
			node.status({ fill: 'red', shape: 'ring', text: 'no account' });
		}

		function evaluate(value, type, msg) {
			return new Promise((resolve, reject) => {
				if (type === 'none' || type === undefined || type === null || type === '') return resolve(undefined);
				RED.util.evaluateNodeProperty(value, type, node, msg, (err, result) => (err ? reject(err) : resolve(result)));
			});
		}

		node.on('input', async (msg, send, done) => {
			try {
				if (!node.account) {
					throw new corbit.CorbitError('No Corbit SMS account is selected', {
						hint: 'Open this node and choose or add a Corbit SMS account.',
					});
				}
				const conn = {
					token: node.account.credentials && node.account.credentials.apiToken,
					baseUrl: node.account.baseUrl,
					signal: closing.signal,
				};
				const op = node.operation;
				node.status({ fill: 'blue', shape: 'dot', text: 'working…' });

				let result;
				let statusText;
				if (op === 'send' || op === 'sendBulk') {
					let sender = await evaluate(config.sender || '', config.senderType || 'str', msg);
					if ((sender === undefined || sender === '') && typeof msg.sender === 'string') sender = msg.sender;
					const message = await evaluate(config.messageType ? config.message : 'payload', config.messageType || 'msg', msg);
					const idempotencyKey = await evaluate(config.idempotencyKey || '', config.idempotencyKeyType || 'none', msg);
					const allowDuplicate = msg.allowDuplicate === true || (msg.allowDuplicate !== false && config.allowDuplicate === true);
					if (op === 'send') {
						const to = await evaluate(config.toType ? config.to : 'to', config.toType || 'msg', msg);
						result = await corbit.sendSms(conn, { sender, to, message, idempotencyKey, allowDuplicate });
						statusText = `sent to ${corbit.maskNumber(result.to)}`;
					} else {
						const numbers = await evaluate(config.numbersType ? config.numbers : 'numbers', config.numbersType || 'msg', msg);
						result = await corbit.sendBulkSms(conn, { sender, numbers, message, idempotencyKey, allowDuplicate });
						statusText = `sent to ${result.recipients} numbers`;
					}
				} else if (op === 'getStatus' || op === 'getReport') {
					const messageId = await evaluate(config.messageIdType ? config.messageId : 'messageId', config.messageIdType || 'msg', msg);
					if (op === 'getStatus') {
						result = await corbit.getStatus(conn, messageId);
						statusText = `status: ${result.status}`;
					} else {
						result = await corbit.getReport(conn, messageId);
						statusText = `${result.recipients.length} recipients`;
					}
				} else if (op === 'getBalance') {
					result = await corbit.getBalance(conn);
					statusText = `balance: ${result.balance}`;
				} else {
					const status = SENDER_STATUSES.includes(config.senderStatus) ? config.senderStatus : 'all';
					result = await corbit.listSenderNames(conn, status);
					statusText = `${result.length} sender names`;
				}

				if (closing.signal.aborted) return done();
				msg.payload = result;
				delete msg.corbitError;
				node.status({ fill: 'green', shape: 'dot', text: statusText });
				send(msg);
				done();
			} catch (error) {
				if (closing.signal.aborted) return done();
				const text = error && error.message ? error.message : String(error);
				node.status({ fill: 'red', shape: 'ring', text: text.length > 40 ? text.slice(0, 39) + '…' : text });
				if (error instanceof corbit.CorbitError) {
					msg.corbitError = {
						message: text,
						...(error.hint ? { hint: error.hint } : {}),
						...(error.code ? { code: error.code } : {}),
						...(error.statusCode ? { statusCode: error.statusCode } : {}),
						...(error.retryAfter ? { retryAfter: error.retryAfter } : {}),
					};
					done(error.hint ? `${text}. ${error.hint}` : text);
				} else {
					done(error);
				}
			}
		});

		node.on('close', () => {
			closing.abort();
			node.status({});
		});
	}

	RED.nodes.registerType('corbit-sms', CorbitSmsNode);

	// ---------------------------------------------------- editor helper routes
	// The editor uses these to fill the sender list and to test the token before
	// deploying. They need write permission on the flows (same as editing them).
	// A token typed in the editor is used with the base URL typed next to it; a
	// stored token is only ever sent to the base URL of its own deployed account.
	function connectionFromRequest(req) {
		const body = req.body || {};
		const typed = typeof body.apiToken === 'string' && body.apiToken !== '' && body.apiToken !== '__PWRD__';
		if (typed) {
			const baseUrl = typeof body.baseUrl === 'string' && body.baseUrl.trim() ? body.baseUrl : undefined;
			return { token: body.apiToken, baseUrl };
		}
		const account = body.account ? RED.nodes.getNode(String(body.account)) : null;
		if (!account || account.type !== 'corbit-sms-account') {
			throw new corbit.CorbitError('The API token is missing', {
				hint: 'Paste the API token in the account settings, or deploy the account first.',
			});
		}
		return { token: account.credentials && account.credentials.apiToken, baseUrl: account.baseUrl };
	}

	function replyError(res, error) {
		const known = error instanceof corbit.CorbitError;
		res.status(400).json({
			error: known ? error.message : 'Unexpected error',
			...(known && error.hint ? { hint: error.hint } : {}),
		});
	}

	RED.httpAdmin.post('/corbit-sms/senders', RED.auth.needsPermission('corbit-sms.write'), async (req, res) => {
		try {
			res.json({ senders: await corbit.approvedSenderNames(connectionFromRequest(req)) });
		} catch (error) {
			replyError(res, error);
		}
	});

	RED.httpAdmin.post('/corbit-sms/test', RED.auth.needsPermission('corbit-sms.write'), async (req, res) => {
		try {
			res.json(await corbit.getBalance(connectionFromRequest(req)));
		} catch (error) {
			replyError(res, error);
		}
	});
};
