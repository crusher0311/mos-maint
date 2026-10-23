# Signed local JSON receiver

Use `mos-local-receiver.cjs` instead of the Cosmos receiver. Only this one file is
needed. It requires Node 20+, no npm packages and no database. Your previous
receiver is unchanged.

## Before switching

The signed receiver requires a securely provisioned shared secret matching the MOS
sender, plus approved enterprise/shop scope. Do not paste secrets into chat.
The earlier empty connectivity test used an ephemeral key; it cannot authenticate
against this receiver. Secret setup and a new test remain separate steps.

Configure locally using secure environment management:

- `MOS_WEBHOOK_SECRET`: shared signing secret, at least 32 bytes.
- `MOS_ENTERPRISE_ID`: approved enterprise identity.
- `MOS_SHOP_IDS`: comma-separated **MOS** shop IDs, not store numbers.
- `MOS_RECEIVED_DIR`: optional private output directory; defaults to
  `received-mos` beside the script.
- `MOS_ALLOW_REAL_EXPORTS`: leave unset. This accepts only signed empty connectivity
  tests. Record-bearing traffic requires separate approval and the value `1`.
- `PORT`: defaults to `3000`.

Then stop the old receiver (Ctrl+C in its terminal, **not** ngrok), and run:

```bat
node mos-local-receiver.cjs
```

Keep ngrok forwarding to `http://localhost:3000`; the destination remains `/webhook`.
No sender configuration or production export activation is changed by this file.

## What gets saved

Each successful delivery creates `received-mos/<delivery-id>.json`, containing the
**exact received JSON bytes**, including the full envelope and raw records.
Open it locally in an editor; the server does not expose files or a history viewer.

- Authentication checks the MOS HMAC, five-minute timestamp window and matching IDs.
- Enterprise/shop restrictions and the complete batch are validated before storage.
- A staged file is flushed, then atomically published without replacing an existing
  delivery. Only then can the server send its acknowledgment.
- Identical retries reuse the same file; changed bytes with the same ID return 409.
- A partial write or save failure never receives an acknowledgment.
- Fresh signatures are required on retries; keep the body and delivery ID identical.

Use a local **NTFS** folder on Windows (hard links required), not FAT/exFAT or an
unverified network/cloud-sync folder. Unsupported filesystems fail closed.
Restrict folder access using Windows permissions; Node's POSIX mode flags alone
do not enforce Windows ACLs. Use disk encryption before retaining customer data.

Keep saved JSON files unchanged: they also provide duplicate-delivery evidence.
Do not delete them while deliveries may be retried. Interrupted attempts may leave
hidden `.tmp` files; these are never acknowledged as completed deliveries.
There is no automatic retention/deletion.

Files are flushed before acknowledgment. POSIX directory entries are also flushed;
Node cannot perform that directory flush on Windows, so this is a local testing
receiver, not a guarantee against abrupt power loss or a failed disk.

## Verification and next step

Automated tests use fictional records, temporary folders and loopback HTTP only.
Windows/NTFS behavior still requires a test on your computer. No Cosmos setup,
production deployment, real export, or shared-secret provisioning is performed.
Next: securely pair the signing secret, then send one approved fictional test.
