'use strict';

// Plain helpers for the Corbit SMS API. They do not depend on Node-RED, so they
// can be tested on their own.

const DEFAULT_BASE_URL = 'https://api.corbit.sa';
const MAX_MESSAGE_LENGTH = 1600;
const MAX_IDEMPOTENCY_KEY_LENGTH = 255;
const REQUEST_TIMEOUT_MS = 30000;

/** An error with a short message for the user and an optional hint and API code. */
class CorbitError extends Error {
	constructor(message, extra = {}) {
		super(message);
		this.name = 'CorbitError';
		if (extra.hint) this.hint = extra.hint;
		if (extra.code) this.code = extra.code;
		if (extra.statusCode) this.statusCode = extra.statusCode;
		if (extra.retryAfter) this.retryAfter = extra.retryAfter;
	}
}

/**
 * Turns a phone number into the digits-only international format the API expects.
 * Accepts "+966 50 123 4567", "00966501234567", "966501234567", "+966 (0)50 123 4567",
 * Arabic-Indic digits, and the Saudi local forms "0501234567" and "501234567".
 * Anything that could turn into a wrong number is rejected instead of guessed:
 * local numbers of other countries, decimals, "9.66501E+11", "ext 12".
 * Returns undefined when the number cannot be used.
 */
function normalizeNumber(raw) {
	let text;
	if (typeof raw === 'number') {
		if (!Number.isSafeInteger(raw) || raw <= 0) return undefined;
		text = String(raw);
	} else if (typeof raw === 'string') {
		text = raw
			.trim()
			.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
			.replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
	} else {
		return undefined;
	}
	if (!/^\+?[\d\s\-()]+$/.test(text)) return undefined;
	let digits = text.replace(/\D/g, '');
	if (text.startsWith('+')) {
		// Already international.
	} else if (digits.startsWith('00')) {
		digits = digits.slice(2);
	} else if (/^05\d{8}$/.test(digits)) {
		digits = '966' + digits.slice(1);
	} else if (/^5\d{8}$/.test(digits)) {
		digits = '966' + digits;
	} else if (digits.startsWith('0')) {
		return undefined;
	}
	// "+966 (0)50 …": drop the trunk zero after the Saudi country code.
	if (/^9660\d{9}$/.test(digits)) digits = '966' + digits.slice(4);
	return /^[1-9]\d{7,14}$/.test(digits) ? digits : undefined;
}

/** Splits a list given as text (commas, semicolons or new lines) or as an array. */
function splitNumbers(value) {
	if (Array.isArray(value)) return value.flatMap((v) => splitNumbers(v));
	if (value === null || value === undefined) return [];
	if (typeof value === 'number') return [value];
	return String(value)
		.split(/[,;\r\n]+/)
		.map((v) => v.trim())
		.filter((v) => v !== '');
}

/** Checks the SMS text and returns it as a string (numbers, e.g. an OTP, are converted). */
function checkMessage(raw) {
	if (raw !== null && raw !== undefined && typeof raw === 'object') {
		throw new CorbitError('The message must be text, not an object', {
			hint: 'Set the Message field to the text of the SMS, or put the text in msg.payload.',
		});
	}
	const message = raw === null || raw === undefined ? '' : String(raw);
	if (message.trim() === '') {
		throw new CorbitError('The message is empty', { hint: 'Put the text of the SMS in msg.payload or in the Message field.' });
	}
	if (message.length > MAX_MESSAGE_LENGTH) {
		throw new CorbitError(`The message is ${message.length} characters; the limit is ${MAX_MESSAGE_LENGTH}`);
	}
	return message;
}

const CODE_HINTS = {
	INSUFFICIENT_BALANCE: 'Your Corbit SMS balance is not enough. Top up at sms.corbit.sa and try again.',
	SENDER_NOT_ALLOWED: 'This sender name is not approved on your account. Pick one from the Sender list.',
	DUPLICATE:
		'The same text was sent to the same number within the last hour. Tick "Allow duplicate" (or set msg.allowDuplicate = true) to send it again on purpose.',
	IDEMPOTENCY_IN_PROGRESS: 'A request with the same idempotency key is still being processed. Wait a moment and try again.',
	IDEMPOTENCY_KEY_REUSED:
		'This idempotency key was already used for a different message. Use a key that is different for each message.',
};

/** Builds a CorbitError from an API error response. */
function errorFromResponse(statusCode, body, headers = {}) {
	const apiMessage = body && typeof body.message === 'string' && body.message ? body.message.slice(0, 300) : '';
	const code = body && typeof body.code === 'string' ? body.code : '';
	let hint = code ? CODE_HINTS[code] : undefined;
	let retryAfter;
	if (statusCode === 401) {
		hint = 'The API token was rejected. Check the API token in the Corbit SMS account settings of this node.';
	} else if (statusCode === 429 || code === 'RATE_LIMIT') {
		retryAfter = headers['retry-after'];
		hint = `Too many requests.${retryAfter ? ` Try again in ${retryAfter} seconds.` : ''}`;
	}
	return new CorbitError(apiMessage || `Corbit SMS returned HTTP ${statusCode}`, {
		hint,
		code: code || undefined,
		statusCode,
		retryAfter,
	});
}

/**
 * Checks the base URL. HTTPS is required, except for a server on this machine
 * (useful for testing), so the token is never sent in clear text over the network.
 */
function cleanBaseUrl(baseUrl) {
	const text = String(baseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
	let url;
	try {
		url = new URL(text);
	} catch {
		url = undefined;
	}
	const local = url && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
	if (!url || !(url.protocol === 'https:' || (url.protocol === 'http:' && local)) || url.username || url.password) {
		throw new CorbitError(`The base URL is not valid: "${text}"`, { hint: `Use ${DEFAULT_BASE_URL}.` });
	}
	return text;
}

/** Header values must be printable ASCII; a pasted token with a line break would otherwise end up in error messages. */
function checkToken(token) {
	const value = token === null || token === undefined ? '' : String(token).trim();
	if (value === '') {
		throw new CorbitError('The API token is missing', {
			hint: 'Open the Corbit SMS account settings of this node and paste your API token from sms.corbit.sa.',
		});
	}
	if (!/^[\x21-\x7e]+$/.test(value)) {
		throw new CorbitError('The API token contains spaces, line breaks or other characters that are not allowed', {
			hint: 'Copy the API token again from sms.corbit.sa and paste it into the Corbit SMS account settings.',
		});
	}
	return value;
}

/**
 * Calls the Corbit SMS API. Returns the parsed body, or throws a CorbitError with
 * the API's own message when the call fails. `signal` cancels the call (e.g. on redeploy);
 * `sends` marks calls that send SMS, so a timeout warns that the SMS may have gone out.
 */
async function apiRequest({ token, baseUrl, method, path, body, query, headers = {}, signal, sends = false, fetchImpl, timeoutMs = REQUEST_TIMEOUT_MS }) {
	const doFetch = fetchImpl || globalThis.fetch;
	if (typeof doFetch !== 'function') {
		throw new CorbitError('This Node.js version has no fetch()', { hint: 'Run Node-RED on Node.js 18 or later.' });
	}
	const cleanToken = checkToken(token);
	let url = cleanBaseUrl(baseUrl) + path;
	if (query) {
		const qs = new URLSearchParams();
		for (const [k, v] of Object.entries(query)) if (v !== undefined) qs.set(k, String(v));
		url += (url.includes('?') ? '&' : '?') + qs.toString();
	}

	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);
	const onAbort = () => controller.abort();
	if (signal) {
		if (signal.aborted) controller.abort();
		else signal.addEventListener('abort', onAbort, { once: true });
	}

	const init = {
		method,
		headers: { Accept: 'application/json', Authorization: `Bearer ${cleanToken}`, ...headers },
		signal: controller.signal,
	};
	if (body !== undefined) {
		init.body = JSON.stringify(body);
		init.headers['Content-Type'] = 'application/json';
	}

	let response;
	let text;
	try {
		response = await doFetch(url, init);
		text = await response.text();
	} catch (error) {
		if (timedOut) {
			throw new CorbitError(
				sends ? `No reply from Corbit SMS within ${Math.round(timeoutMs / 1000)} seconds; the SMS may have been sent` : `No reply from Corbit SMS within ${Math.round(timeoutMs / 1000)} seconds`,
				{
					hint: sends
						? 'Check the message status or your Corbit SMS account before you send again, so the SMS is not sent twice.'
						: 'Try again later.',
				},
			);
		}
		if (controller.signal.aborted) throw new CorbitError('The request was cancelled');
		// Never put the error text itself in the message: it can contain header values.
		const code = error && error.cause && typeof error.cause.code === 'string' ? error.cause.code : 'network error';
		throw new CorbitError(`Could not reach Corbit SMS (${code})`, {
			hint: 'Check the internet connection of the Node-RED server and the base URL.',
		});
	} finally {
		clearTimeout(timer);
		if (signal) signal.removeEventListener('abort', onAbort);
	}

	let data;
	try {
		data = text ? JSON.parse(text) : {};
	} catch {
		data = {};
	}
	const parsed = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
	const responseHeaders = {};
	if (response.headers && typeof response.headers.forEach === 'function') {
		response.headers.forEach((v, k) => {
			responseHeaders[k.toLowerCase()] = v;
		});
	}
	if (response.status >= 400 || parsed.status === 'Error') {
		throw errorFromResponse(response.status, parsed, responseHeaders);
	}
	if (Array.isArray(data)) return { data };
	return parsed;
}

/**
 * Reads the sender names page by page. Stops after `maxItems` names when given,
 * when the last page is reached, or when the API keeps returning the same page.
 */
async function getAllSenderNames(conn, maxItems) {
	const perPage = 50;
	const all = [];
	let previousFirst;
	for (let page = 1; page <= 100; page++) {
		const response = await apiRequest({ ...conn, method: 'GET', path: '/api/v1/sendernames', query: { per_page: perPage, page } });
		const items = Array.isArray(response.data) ? response.data : [];
		if (items.length === 0) break;
		const first = JSON.stringify(items[0]);
		if (page > 1 && first === previousFirst) break;
		previousFirst = first;
		all.push(...items);
		if (maxItems !== undefined && all.length >= maxItems) break;
		const pagination = response.pagination || {};
		const total = Number(pagination.total);
		const currentPage = Number(pagination.current_page);
		const pageSize = Number(pagination.per_page) || perPage;
		if (Number.isFinite(total) && all.length >= total) break;
		if (!Number.isFinite(total) && items.length < pageSize) break;
		if (Number.isFinite(currentPage) && currentPage !== page) break;
	}
	return maxItems === undefined ? all : all.slice(0, maxItems);
}

/** Approved sender names, sorted, for the editor list. */
async function approvedSenderNames(conn) {
	const all = await getAllSenderNames(conn);
	return [...new Set(all.filter((s) => String(s.status).toLowerCase() === 'approved').map((s) => String(s.name)))].sort((a, b) =>
		a.localeCompare(b),
	);
}

function sendHeaders({ idempotencyKey, allowDuplicate }) {
	const headers = {};
	if (idempotencyKey !== undefined && idempotencyKey !== null && String(idempotencyKey) !== '') {
		if (typeof idempotencyKey === 'object') {
			throw new CorbitError('The idempotency key must be text, not an object');
		}
		const key = String(idempotencyKey);
		if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
			throw new CorbitError(`The idempotency key is ${key.length} characters; the limit is ${MAX_IDEMPOTENCY_KEY_LENGTH}`);
		}
		if (!/^[\x20-\x7e]+$/.test(key)) {
			throw new CorbitError('The idempotency key may only contain English letters, digits and symbols', {
				hint: 'Use an ID such as an order number.',
			});
		}
		headers['Idempotency-Key'] = key;
	}
	if (allowDuplicate === true) headers['X-Allow-Duplicate'] = 'true';
	return headers;
}

function checkSender(raw) {
	const sender = raw === null || raw === undefined || typeof raw === 'object' ? '' : String(raw).trim();
	if (sender === '') {
		throw new CorbitError('No sender name', { hint: 'Choose an approved sender name in the node, or set msg.sender.' });
	}
	return sender;
}

function describe(value) {
	if (value === undefined || value === null) return '';
	return typeof value === 'object' ? JSON.stringify(value).slice(0, 60) : String(value).slice(0, 60);
}

/** Sends one SMS. Returns { messageId, status, to, senderName }. */
async function sendSms(conn, { sender, to, message, idempotencyKey, allowDuplicate }) {
	const senderName = checkSender(sender);
	const number = normalizeNumber(to);
	if (!number) {
		throw new CorbitError(`The mobile number is not valid: "${describe(to)}"`, {
			hint: 'Use the international format, e.g. 966501234567. Saudi local numbers (05XXXXXXXX) are converted automatically.',
		});
	}
	const messageBody = checkMessage(message);
	const headers = sendHeaders({ idempotencyKey, allowDuplicate });
	const response = await apiRequest({
		...conn,
		method: 'POST',
		path: '/api/v1/send',
		body: { senderName, number, messageBody, sendAtOption: 'NOW' },
		headers,
		sends: true,
	});
	const sent = (response.data && response.data.message) || {};
	return { messageId: sent.id, status: sent.status, to: number, senderName };
}

/** Sends the same SMS to many numbers. Returns { messageId, status, recipients, numbers, senderName }. */
async function sendBulkSms(conn, { sender, numbers: rawNumbers, message, idempotencyKey, allowDuplicate }) {
	const senderName = checkSender(sender);
	const raw = splitNumbers(rawNumbers);
	const invalid = raw.filter((n) => !normalizeNumber(n)).map(describe);
	if (invalid.length > 0) {
		throw new CorbitError(
			`Invalid mobile numbers: ${invalid.slice(0, 5).join(', ')}${invalid.length > 5 ? ` and ${invalid.length - 5} more` : ''}`,
			{
				hint: 'Use the international format, e.g. 966501234567. Corbit SMS rejects the whole request if any number is invalid, so nothing was sent.',
			},
		);
	}
	const numbers = [...new Set(raw.map((n) => normalizeNumber(n)))];
	if (numbers.length === 0) {
		throw new CorbitError('The list of numbers is empty', { hint: 'Put the numbers in msg.numbers (an array or comma-separated text) or in the Numbers field.' });
	}
	const messageBody = checkMessage(message);
	const headers = sendHeaders({ idempotencyKey, allowDuplicate });
	const response = await apiRequest({
		...conn,
		method: 'POST',
		path: '/api/v1/send-bulk',
		body: { senderName, numbers, messageBody, sendAtOption: 'Now' },
		headers,
		sends: true,
	});
	const sent = (response.data && response.data.message) || {};
	return { messageId: sent.id, status: sent.status, recipients: numbers.length, numbers, senderName };
}

function checkMessageId(raw) {
	const id = raw === null || raw === undefined || typeof raw === 'object' ? '' : String(raw).trim();
	if (id === '') {
		throw new CorbitError('The message ID is empty', { hint: 'Use the messageId returned by a send, e.g. msg.payload.messageId.' });
	}
	return id;
}

/** Returns { messageId, status }. */
async function getStatus(conn, messageId) {
	const id = checkMessageId(messageId);
	const response = await apiRequest({ ...conn, method: 'POST', path: '/api/v1/message-status/' + encodeURIComponent(id) });
	return { messageId: id, status: (response.data || {}).status };
}

/** Returns { messageId, jobId, recipients: [...] } with one entry per recipient. */
async function getReport(conn, messageId) {
	const id = checkMessageId(messageId);
	const response = await apiRequest({ ...conn, method: 'POST', path: '/api/v1/message-report/' + encodeURIComponent(id) });
	const recipients = Array.isArray(response.msgs) ? response.msgs : [];
	return { messageId: id, jobId: response.jobId, recipients };
}

/** Returns { balance }. */
async function getBalance(conn) {
	const response = await apiRequest({ ...conn, method: 'POST', path: '/api/v1/get-balance' });
	return { balance: (response.data || {}).balance };
}

/** Returns the sender names, optionally only those with one status. */
async function listSenderNames(conn, status) {
	const all = await getAllSenderNames(conn);
	if (!status || status === 'all') return all;
	return all.filter((s) => String(s.status).toLowerCase() === status);
}

/** Shows only the last 4 digits of a number, for the node status under the node. */
function maskNumber(number) {
	const s = String(number || '');
	return s.length > 4 ? '…' + s.slice(-4) : s;
}

module.exports = {
	CorbitError,
	DEFAULT_BASE_URL,
	MAX_MESSAGE_LENGTH,
	MAX_IDEMPOTENCY_KEY_LENGTH,
	normalizeNumber,
	splitNumbers,
	checkMessage,
	cleanBaseUrl,
	errorFromResponse,
	apiRequest,
	getAllSenderNames,
	approvedSenderNames,
	sendSms,
	sendBulkSms,
	getStatus,
	getReport,
	getBalance,
	listSenderNames,
	maskNumber,
};
