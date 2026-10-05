---
name: Render outbound-IP allowlists
description: How to safely maintain external firewall rules for Render services.
---

Do not trust a remembered or previously configured Render shared outbound range. Query the Render service's current outbound-IP endpoint before changing an external firewall, add all current ranges first, verify completed application responses, and only then remove obsolete ranges.

**Why:** Render can replace regional outbound ranges. A stale AWS allowlist allowed the relay containers and internal proxy health checks to pass while production logged request starts with no response completions. Public checks from unrelated networks were also expected to time out because the firewall was intentionally restricted.

**How to apply:** For a Render service that calls an IP-restricted upstream, compare the service's live `/v1/services/{serviceId}/outbound-ips` response with the firewall. Validate from post-promotion runtime response logs, not request-start logs or internal container health alone.