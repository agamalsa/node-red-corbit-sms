# Changelog

## 1.0.1 (2026-11-08)

- No change to the node itself.
- Tests now also run on Node.js 18 with Node-RED 3, and CI checks Node.js 18, 20, 22 and 24 with Node-RED 3, 4 and 5.
- Published from GitHub Actions with npm provenance.

## 1.0.0 (2026-11-08)

First release.

- **Send SMS** to one number and **Send SMS to many numbers** in one request.
- **Get message status** and **Get delivery report** (one entry per recipient).
- **Get balance** and **Get sender names** (filter by status).
- Account node with **Test connection**, and a **Load my sender names** button in the editor.
- Phone numbers are normalized; Saudi local numbers (05XXXXXXXX) are converted, and local numbers of other countries are rejected.
- Duplicate protection switch, idempotency key for safe retries, and clear errors for Catch nodes in `msg.corbitError`.
- Two example flows: send an OTP and check delivery, and a daily low-balance check.
