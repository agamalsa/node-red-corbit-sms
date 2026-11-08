# @corbit2/node-red-corbit-sms

A [Node-RED](https://nodered.org) node for [Corbit SMS](https://sms.corbit.sa), an SMS gateway in Saudi Arabia. Send SMS messages from your flows, check whether they were delivered, and read your balance and sender names.

- [Install](#install)
- [Set up your account](#set-up-your-account)
- [Operations](#operations)
- [Inputs and outputs](#inputs-and-outputs)
- [Errors](#errors)
- [Example flows](#example-flows)
- [Requirements](#requirements)

## Install

In the Node-RED editor, open **Menu → Manage palette → Install**, search for `@corbit2/node-red-corbit-sms` and click **Install**.

Or run this in your Node-RED user directory (usually `~/.node-red`) and restart Node-RED:

```bash
npm install @corbit2/node-red-corbit-sms
```

## Set up your account

You need a Corbit SMS account and an API token.

1. Sign in at [sms.corbit.sa](https://sms.corbit.sa) and copy your API token.
2. Drag a **Corbit SMS** node (in the *network* category) into a flow and open it.
3. Next to **Account**, click the pencil to add an account, paste the token and click **Test connection**. You should see your balance.

Keep **Base URL** as `https://api.corbit.sa` unless Corbit support gives you another address (it must use HTTPS). The token is stored with the Node-RED credentials, so it is not included when you export a flow.

## Operations

| Operation | What it does |
|---|---|
| Send SMS | Sends an SMS to one mobile number |
| Send SMS to many numbers | Sends the same SMS to many numbers in one request |
| Get message status | Returns the current status of a sent message |
| Get delivery report | Returns the delivery result for each recipient |
| Get balance | Returns the remaining SMS balance |
| Get sender names | Lists your sender names and their status |

## Inputs and outputs

By default the node reads these message properties. Each field can be changed to another message property, a fixed value, a flow or global value or an environment variable; all fields except Sender also accept a JSONata expression.

| Property | Used by | Meaning |
|---|---|---|
| `msg.payload` | Send, Send to many | Text of the SMS, up to 1600 characters. Numbers (such as an OTP) are accepted. |
| `msg.to` | Send | Mobile number, e.g. `966501234567` |
| `msg.numbers` | Send to many | Array of numbers, or text separated by commas or new lines |
| `msg.messageId` | Get status, Get report | The `messageId` returned by a send |
| `msg.sender` | Send, Send to many | Sender name, used when the **Sender** field is empty |
| `msg.allowDuplicate` | Send, Send to many | `true` or `false`; overrides the **Duplicates** box |

The result is written to `msg.payload`; the other message properties are kept.

| Operation | `msg.payload` |
|---|---|
| Send SMS | `{ messageId, status, to, senderName }` |
| Send SMS to many numbers | `{ messageId, status, recipients, numbers, senderName }` |
| Get message status | `{ messageId, status }` |
| Get delivery report | `{ messageId, jobId, recipients: [...] }` |
| Get balance | `{ balance }` |
| Get sender names | Array of `{ name, status, ... }` |

**Phone numbers.** Spaces, dashes, brackets, a leading `+` or `00` are removed, and Arabic digits are accepted. Saudi local numbers (`05XXXXXXXX`) become `9665XXXXXXXX`. Anything that could turn into a wrong number is rejected and nothing is sent: local numbers of other countries (starting with `0`; write them in international format), decimals such as `9.66501E+11` from a spreadsheet, and extra text such as `ext 12`.

**Sender name.** Click **Load my sender names** to pick one of your approved names, or type it.

**Send to many.** Duplicate numbers are removed. If any number is invalid, nothing is sent, because Corbit SMS rejects the whole request.

**Duplicates.** Corbit SMS blocks the same text to the same number within one hour. Tick **Duplicates** (or set `msg.allowDuplicate = true`) for a resend on purpose, such as an OTP resend.

**Safe retries.** Set **Idempotency** to a value that identifies the event behind the message, for example an order or request ID such as `msg.orderId`. If the same request is repeated with the same key, Corbit SMS returns the first result and does not send again. Don't use one fixed value for every message, and don't use `msg._msgid` on its own: messages from a Split node, or sent to several nodes, share it, so only the first SMS would be sent.

**Timeouts.** If Corbit SMS doesn't reply within 30 seconds, the node reports an error, but the SMS may still have been sent. Check its status before you send it again.

**Rate limit.** 1000 requests per minute per token.

## Errors

When a call fails, the node shows the error under the node, reports it to any **Catch** node, and adds `msg.corbitError`:

```json
{
  "message": "Duplicate request blocked",
  "hint": "The same text was sent to the same number within the last hour. ...",
  "code": "DUPLICATE",
  "statusCode": 409
}
```

Invalid input (an empty message, a wrong number, no sender name) is caught before any request is made.

## Example flows

Import them from **Menu → Import → Examples → @corbit2/node-red-corbit-sms**.

- **send-otp-and-check-delivery**: an inject node sends a one-time code to `msg.to`, waits 30 seconds and reads the delivery status. A Catch node shows `msg.corbitError` if something fails. Before you deploy it, paste your token in the account node, pick your sender name and set your own number.
- **check-balance**: reads the balance every morning at 9 and shows a warning when it is below 100.

## Requirements

- Node-RED 3.0 or later (tested with Node-RED 3.1, 4.1 and 5.0)
- Node.js 18.17 or later (tested with Node.js 24)

## Links

- [Corbit SMS API documentation](https://api.corbit.sa/doc)
- [Report a problem](https://github.com/agamalsa/node-red-corbit-sms/issues)

## License

[MIT](LICENSE)
