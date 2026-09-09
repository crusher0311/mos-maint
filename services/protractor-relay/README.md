# Protractor egress relay

A dependency-free Node 20 relay with one fixed production destination:
`https://integration.protractor.com`. TLS terminates at the colocated Caddy
container. The relay has no database. It persists short-lived replay
reservations in an fsync'd append-only journal under
`/var/lib/protractor-relay`; the Compose example mounts that directory on a
durable local EC2 volume.

## Request contract

`GET /healthz` is unauthenticated. The only relay operation is `POST /relay`
with `Content-Type: application/json`:

```json
{
  "type": "rest",
  "method": "GET",
  "path": "/IntegrationServices/2.0/RepairOrders?shopId=123",
  "headers": {
    "Authorization": "Basic ...",
    "Accept": "application/json"
  }
}
```

`type` is `rest` or `soap`. REST permits `GET`, `POST`, `PUT`, `PATCH`, and
`DELETE`; SOAP permits only `POST`. `path` must be an origin-relative
`/IntegrationServices/1.0` or `/IntegrationServices/2.0` path. Optional
`body` is UTF-8 by default. Set `bodyEncoding` to `base64` for exact binary
transfer. End-to-end headers, including Protractor authorization and
`SOAPAction`, are passed through; hop-by-hop, host, content-length, and relay
authentication headers are removed. Redirect responses are returned without
being followed.

Relay-generated admission, authentication, replay, and upstream-transport
errors include an `X-Relay-Error-Code` safe enum header. Responses proxied from
Protractor never include this marker, even when their status is 4xx/5xx; MOS
uses it to avoid attributing relay failures to the provider or retrying them.

Four headers authenticate the exact raw JSON bytes:

* `X-Relay-Timestamp`: current Unix seconds
* `X-Relay-Nonce`: 16-128 base64url-safe characters, unique per request
* `X-Relay-Request-Id`: 8-128 letters, digits, `.`, `_`, `:`, or `-`
* `X-Relay-Signature`: `sha256=` followed by lowercase/uppercase hex HMAC

The signed bytes are:

```text
timestamp + "\n" +
nonce + "\n" +
requestId + "\n" +
"POST\n/relay\n" +
hex_sha256(raw_json_body)
```

Compute HMAC-SHA-256 over that string using `RELAY_HMAC_SECRET`. Do not
re-serialize JSON after signing. Timestamp acceptance defaults to ±60 seconds.
Each valid nonce/request-ID pair is rejected for at least 120 seconds after
first use, and reservations cover the complete timestamp acceptance window.
Reservations are fsync'd before an upstream request and loaded/pruned on
restart. The journal is host-local: run one relay replica per host, retain its
volume across restarts, and do not share it between hosts.

## Configuration

Required: `RELAY_HMAC_SECRET`, supplied only through the environment and at
least 32 bytes. Optional bounded settings are `PORT` (8080),
`REQUEST_BODY_LIMIT_BYTES` (1048576),
`RESPONSE_BODY_LIMIT_BYTES` (5242880), `HMAC_CLOCK_SKEW_SECONDS` (60), and
`REPLAY_TTL_SECONDS` (120). REST upstream deadlines are 60 seconds and SOAP
deadlines are 120 seconds (`REST_TIMEOUT_MS`/`SOAP_TIMEOUT_MS`); callers cannot
extend them. `REQUEST_TIMEOUT_MS` (10000) limits inbound requests, and
`MAX_CONCURRENT_INGRESS` (64) and `MAX_CONCURRENT_UPSTREAMS` (32) provide
admission control. `REPLAY_MAX_ENTRIES` (100000) and
`REPLAY_JOURNAL_MAX_BYTES` (10485760) bound replay storage; the relay fails
closed when the journal is full. The destination is not configurable in
production.
`RELAY_UPSTREAM` works only with `NODE_ENV=test` for local automated tests.

Logs are newline-delimited JSON and intentionally omit request/response
bodies, headers, query strings, signatures, nonces, and upstream credentials.

## Test and deploy to EC2

```sh
cd services/protractor-relay
npm test
tar --exclude='.git' -czf protractor-relay.tar.gz .
scp protractor-relay.tar.gz ec2-user@HOST:
```

On an EC2 host with Docker Engine and Compose:

```sh
mkdir protractor-relay && tar -xzf protractor-relay.tar.gz -C protractor-relay
cd protractor-relay
umask 077
cat > .env <<'EOF'
RELAY_HOSTNAME=relay.example.com
RELAY_HMAC_SECRET=replace-with-a-random-secret-of-at-least-32-bytes
EOF
docker compose -f compose.example.yml up -d --build
curl https://relay.example.com/healthz
```

Do not expose 8080. Permit inbound TCP 443 in the EC2 security group **only
from the exact trusted Render outbound CIDR ranges used by the caller**.
Obtain those CIDRs from the Render deployment/network owner and keep the
security-group rule set current; do not use `0.0.0.0/0`. If health monitoring
does not originate in those ranges, use a separate private/status path or a
trusted monitoring egress rather than opening the relay publicly. Port 80 may
be allowed only if needed for Caddy certificate HTTP-01 challenges, and should
otherwise be closed.
Restrict outbound traffic to TCP 443 and, where network controls support
stable DNS/FQDN policy, `integration.protractor.com`. Keep `.env` mode 0600,
use a randomly generated secret, rotate it through the caller and relay
together, and never bake it into an image. Caddy obtains and renews the public
certificate. Pin and regularly update the Node and Caddy image versions.