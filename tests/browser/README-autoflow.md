# AutoFlow admin offline browser check

This harness renders the actual admin React components with compiled Tailwind
styles. Its HTTP APIs only mutate in-memory fixture state; it never imports
application authentication, database repositories, or upstream clients.

```sh
# Terminal/workflow 1
node_modules/.bin/tsx tests/browser/autoflow-admin-fixture-server.ts
# Terminal 2 (Chromium must be installed)
node_modules/.bin/tsx tests/browser/autoflow-admin-ui.smoke.ts
```

Use `AUTOFLOW_FIXTURE_PORT=5000` on both commands for a Replit webview workflow;
the standalone default is 5100. `CHROMIUM_PATH` can override `which chromium`.
Stop the fixture workflow after verification; it is not the application server.

The test resets fixture state before each run, checks manual attachment while
the unresolved list is empty, validates the outgoing 615/MOS-432 request, checks
refreshed mappings, races two shop detail requests, saves explicit classifications,
resets rules, and verifies a failed detail load cannot save another shop's rules.
Screenshots are written to `screenshots/autoflow-admin.jpg` and
`screenshots/autoflow-workflow.jpg`.

These are sanitized test shops, not live ownership evidence or production results.