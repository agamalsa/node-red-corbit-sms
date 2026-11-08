'use strict';

// A tiny stand-in for the Corbit SMS API. Each test queues the replies it wants
// and reads back the requests the node made.
const http = require('node:http');

function createMockApi() {
	const requests = [];
	let replies = [];
	const server = http.createServer((req, res) => {
		let raw = '';
		req.on('data', (c) => (raw += c));
		req.on('end', () => {
			let body;
			try {
				body = raw ? JSON.parse(raw) : undefined;
			} catch {
				body = raw;
			}
			requests.push({ method: req.method, url: req.url, headers: req.headers, body });
			const reply = replies.shift() || { status: 200, body: { status: 'Success', data: {} } };
			res.writeHead(reply.status || 200, { 'Content-Type': 'application/json', ...(reply.headers || {}) });
			res.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body));
		});
	});
	return {
		requests,
		reply(...list) {
			replies.push(...list);
		},
		reset() {
			requests.length = 0;
			replies = [];
		},
		async start() {
			await new Promise((r) => server.listen(0, '127.0.0.1', r));
			return `http://127.0.0.1:${server.address().port}`;
		},
		stop() {
			return new Promise((r) => server.close(r));
		},
	};
}

const ok = (body) => ({ status: 200, body });
const fail = (status, body, headers) => ({ status, body, headers });

module.exports = { createMockApi, ok, fail };
