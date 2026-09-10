---
name: Protractor relay EC2 deployment
description: Host-specific access and Docker build constraints for safely replacing the singleton Protractor relay.
---

Store the EC2 SSH PEM as Base64 in Replit Secrets, then decode it into a mode-0600 temporary file for each connection. A multiline PEM pasted directly into the secret form was collapsed into one line and failed OpenSSH validation.

**Why:** The relay host is reachable only after its security group temporarily allows the workspace egress IP. Preserving the key as Base64 avoids newline damage without exposing the key in chat or the repository.

**How to apply:** Permit the current workspace egress IP as a temporary `/32` SSH rule, decode the Base64 key under `/tmp`, connect as `ec2-user`, and remove the temporary key after each command. Remove the temporary AWS rule when deployment work is finished.

The host's Docker Compose requires Buildx 0.17 or later, but its installed Buildx plugin is older. Build the relay image with the compatible legacy builder, then run Compose with `--no-build`.

**Why:** `docker compose build` fails before creating an image. Installing or upgrading host-wide Docker tooling during a safety-sensitive relay replacement creates unnecessary risk.

**How to apply:** Build `protractor-relay-protractor-relay:latest` with `DOCKER_BUILDKIT=0 docker build`, then follow the documented singleton stop-140s, remove, and `docker compose up -d --no-build` sequence.