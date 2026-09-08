#!/usr/bin/env node

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { createHmac } = require("node:crypto");
const puppeteer = require("puppeteer-core");

function devBaseUrl() {
  const supplied = process.argv[2] || process.env.REPLIT_DEV_DOMAIN;
  if (!supplied) {
    throw new Error("Pass the dev URL as argv[2], or set REPLIT_DEV_DOMAIN.");
  }
  const url = new URL(/^[a-z]+:\/\//i.test(supplied) ? supplied : `https://${supplied}`);
  const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  const isReplitDev = url.hostname.endsWith(".replit.dev") || url.hostname.endsWith(".repl.co");
  assert.ok(isLocal || isReplitDev, `Refusing to run browser interaction test against non-dev host: ${url.hostname}`);
  return url.origin;
}

const API_PATH = "/api/platform-admin/appfueled-url-events";
const CONNECTION_ENABLED_ID = "11111111-1111-4111-8111-111111111111";
const CONNECTION_DISABLED_ID = "22222222-2222-4222-8222-222222222222";
const RECEIPT_ID = "33333333-3333-4333-8333-333333333333";
const SECRET_URL = "https://dev.example.test/api/appfueled/url-events?credential=one-time-test-secret";

function testAuthToken() {
  const secret = process.env.E2E_TEST_SECRET;
  assert.ok(secret && secret.length >= 16,
    "E2E_TEST_SECRET must match the dev server so the protected platform-admin page can render");
  const payload = Buffer.from(JSON.stringify({
    shopId: 1,
    email: "appfueled-browser-fixture@example.test",
    role: "platform_admin",
    isPlatformAdmin: true,
    exp: Date.now() + 5 * 60_000,
  })).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

const connections = [
  {
    id: CONNECTION_ENABLED_ID,
    connectionId: "appfueled-enabled",
    mosShopId: 101,
    incomingShopId: 7001,
    shopIdNamespace: "provider",
    namespaceConfirmation: "Verified manually with provider support.",
    allowedHosts: ["vehicles.customer.example"],
    enabled: true,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    lastSuccessAt: "2025-01-02T03:04:05.000Z",
    lastReceiptId: RECEIPT_ID,
  },
  {
    id: CONNECTION_DISABLED_ID,
    connectionId: "appfueled-disabled",
    mosShopId: 202,
    incomingShopId: 7002,
    shopIdNamespace: "mos",
    namespaceConfirmation: "Confirmed against the signed onboarding sheet.",
    allowedHosts: ["inventory.customer.example"],
    enabled: false,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    lastSuccessAt: null,
    lastReceiptId: null,
  },
];

const receipts = [{
  id: RECEIPT_ID,
  receivedAt: "2025-01-02T03:04:05.000Z",
  connectionId: "appfueled-enabled",
  mosShopId: "101",
  vin: "1HGBH41JXMN109186",
  payload: {
    event: "vehicle_url",
    nested: { safe: "<script>not executable</script>" },
    credential: "[REDACTED]",
  },
  outcome: "accepted",
  durationMs: 17,
  correlationId: "browser-fixture-correlation",
}];

function feed(baseUrl, page = 1, empty = false) {
  return {
    connections: empty ? [] : connections,
    receipts: empty ? [] : receipts,
    hasMore: !empty && page === 1,
    page,
    vehicleUrls: empty ? [] : [{
      connectionId: "appfueled-enabled",
      mosShopId: "101",
      vin: "1HGBH41JXMN109186",
      vehicleUrl: "https://vehicles.customer.example/car/1?do-not-navigate=true",
      receivedAt: "2025-01-02T03:04:05.000Z",
      receiptId: RECEIPT_ID,
    }],
    baseUrl,
  };
}

async function text(page) {
  return page.evaluate(() => document.body.innerText);
}

async function waitForText(page, expected) {
  await page.waitForFunction(
    value => document.body.innerText.includes(value),
    { timeout: 8_000 },
    expected,
  );
}

async function clickText(page, selector, expected, occurrence = 0) {
  const handles = await page.$$(selector);
  let seen = 0;
  for (const handle of handles) {
    const value = await handle.evaluate(element => (element.textContent || "").trim());
    if (value === expected || value.includes(expected)) {
      if (seen++ === occurrence) {
        await handle.click();
        return;
      }
    }
  }
  throw new Error(`Could not find ${selector} containing "${expected}" (occurrence ${occurrence})`);
}

async function fieldInLabel(page, labelText, selector = "input, textarea, select") {
  const handle = await page.evaluateHandle(({ labelText, selector }) => {
    const label = [...document.querySelectorAll("label")]
      .find(candidate => (candidate.textContent || "").includes(labelText));
    return label?.querySelector(selector) || null;
  }, { labelText, selector });
  const element = handle.asElement();
  assert.ok(element, `Missing field labelled "${labelText}"`);
  return element;
}

async function replaceValue(page, handle, value) {
  await handle.click({ clickCount: 3 });
  await page.keyboard.press("Backspace");
  await handle.type(value);
}

async function waitForApiCount(requests, minimum) {
  const deadline = Date.now() + 8_000;
  while (requests.length < minimum) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for API request ${minimum}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

async function main() {
  const baseUrl = devBaseUrl();
  const chromium = execFileSync("sh", ["-c", "command -v chromium"], { encoding: "utf8" }).trim();
  assert.ok(chromium, "Local chromium executable was not found");

  const browser = await puppeteer.launch({
    executablePath: chromium,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  let nextGet = null;
  const requests = [];
  const patchBodies = [];
  let postBody = null;

  try {
    const page = await browser.newPage();
    await page.emulateTimezone("UTC");
    // The page itself is protected by the server-rendered platform-admin
    // layout. Authenticate through the existing test-only HMAC gate rather
    // than relying on a developer's browser cookies or weakening app auth.
    await page.setExtraHTTPHeaders({ "x-test-auth": testAuthToken() });
    await page.setRequestInterception(true);
    page.on("request", request => {
      const url = new URL(request.url());
      if (url.pathname !== API_PATH) {
        request.continue();
        return;
      }

      const method = request.method();
      const parsedBody = request.postData() ? JSON.parse(request.postData()) : null;
      requests.push({ method, url: url.toString(), body: parsedBody });

      if (method === "GET") {
        const special = nextGet;
        nextGet = null;
        const pageNumber = Number(url.searchParams.get("page") || "1");
        const status = special?.status || 200;
        const body = special?.body ?? feed(baseUrl, pageNumber, special?.empty);
        const respond = () => request.respond({
          status,
          contentType: "application/json",
          body: JSON.stringify(body),
        });
        if (special?.delay) setTimeout(respond, special.delay);
        else respond();
        return;
      }

      if (method === "POST") {
        postBody = parsedBody;
        request.respond({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({
            webhookUrl: SECRET_URL,
            connection: { connectionId: parsedBody.connectionId },
          }),
        });
        return;
      }

      if (method === "PATCH") {
        patchBodies.push(parsedBody);
        const connection = connections.find(item => item.id === parsedBody.id);
        if (connection) connection.enabled = parsedBody.action === "rotate" ? true : false;
        request.respond({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            connection,
            ...(parsedBody.action === "rotate" ? { webhookUrl: `${SECRET_URL}-rotated` } : {}),
          }),
        });
        return;
      }

      request.respond({ status: 405, contentType: "application/json", body: '{"error":"Unexpected method"}' });
    });

    await page.goto(`${baseUrl}/platform-admin/appfueled-url-events`, {
      waitUntil: "domcontentloaded",
      timeout: 90_000,
    });
    await waitForText(page, "appfueled-enabled");

    // Receipt evidence is expanded as inert, sanitized text.
    await clickText(page, "button", "View sanitized JSON");
    await waitForText(page, '"credential": "[REDACTED]"');
    const injectedScripts = await page.$$eval("script", scripts =>
      scripts.filter(script => script.textContent?.includes("not executable")).length);
    assert.equal(injectedScripts, 0, "Payload text must not create a script element");
    assert.ok((await text(page)).includes("<script>not executable</script>"));

    // Candidate URLs are deliberately text, never links.
    const candidateUrl = "https://vehicles.customer.example/car/1?do-not-navigate=true";
    assert.ok((await text(page)).includes(candidateUrl));
    const candidateLinks = await page.$$eval("a", (links, url) =>
      links.filter(link => link.textContent?.includes(url) || link.href === url).length, candidateUrl);
    assert.equal(candidateLinks, 0);

    // Native form controls produce the UUID value and UTC ISO date boundaries.
    await (await fieldInLabel(page, "MOS shop ID")).type("101");
    await (await fieldInLabel(page, "VIN")).type("1HGBH41JXMN109186");
    await (await fieldInLabel(page, "Connection", "select")).select(CONNECTION_ENABLED_ID);
    await (await fieldInLabel(page, "From", 'input[type="date"]')).evaluate((input) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "2025-02-03");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await (await fieldInLabel(page, "To", 'input[type="date"]')).evaluate((input) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "2025-02-04");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const requestCountBeforeFilter = requests.length;
    await clickText(page, "button", "Search");
    await waitForApiCount(requests, requestCountBeforeFilter + 1);
    await page.waitForFunction(() => !document.querySelector('[class*="animate-pulse"]'));
    const filterRequest = [...requests].reverse().find(item => item.method === "GET");
    const filterUrl = new URL(filterRequest.url);
    assert.equal(filterUrl.searchParams.get("connectionId"), CONNECTION_ENABLED_ID);
    assert.equal(filterUrl.searchParams.get("shopId"), "101");
    assert.equal(filterUrl.searchParams.get("vin"), "1HGBH41JXMN109186");
    assert.equal(filterUrl.searchParams.get("from"), "2025-02-03T00:00:00.000Z");
    assert.equal(filterUrl.searchParams.get("to"), "2025-02-04T23:59:59.999Z");

    // Setup captures exact numeric IDs, explicit namespace provenance, bare host, and base URL confirmation.
    await clickText(page, "button", "Configure feed");
    await waitForText(page, "Configure AppFueled feed");
    await replaceValue(page, await fieldInLabel(page, "Connection identifier"), "browser-created");
    await replaceValue(page, await fieldInLabel(page, "Known MOS shop ID"), "101");
    await replaceValue(page, await fieldInLabel(page, "Incoming numeric shop identifier"), "7009");
    await (await fieldInLabel(page, "Identifier namespace", "select")).select("provider");
    await replaceValue(page, await fieldInLabel(page, "Namespace confirmation note", "textarea"), "Manually verified with AppFueled operator.");
    await replaceValue(page, await fieldInLabel(page, "Allowed exact public DNS hostnames", "textarea"), "cars.customer.com");
    await (await fieldInLabel(page, "I confirm this exact base URL", 'input[type="checkbox"]')).click();
    const requestCountBeforeSetup = requests.length;
    await clickText(page, "button", "Create secure feed");
    await waitForText(page, "One-time credential reveal");
    assert.deepEqual(
      {
        connectionId: postBody.connectionId,
        mosShopId: postBody.mosShopId,
        incomingShopId: postBody.incomingShopId,
        shopIdNamespace: postBody.shopIdNamespace,
        namespaceConfirmation: postBody.namespaceConfirmation,
        allowedHosts: postBody.allowedHosts,
        hostConfirmed: postBody.hostConfirmed,
        confirmedBaseUrl: postBody.confirmedBaseUrl,
      },
      {
        connectionId: "browser-created",
        mosShopId: 101,
        incomingShopId: 7009,
        shopIdNamespace: "provider",
        namespaceConfirmation: "Manually verified with AppFueled operator.",
        allowedHosts: ["cars.customer.com"],
        hostConfirmed: true,
        confirmedBaseUrl: baseUrl,
      },
    );
    assert.equal(typeof postBody.mosShopId, "number");
    assert.equal(typeof postBody.incomingShopId, "number");
    assert.ok((await text(page)).includes(SECRET_URL));
    await clickText(page, "button", "I copied it");
    await waitForText(page, "was revealed once and is now masked");
    assert.ok((await text(page)).includes("Rotate it if secure delivery cannot be confirmed."));
    assert.ok(!(await text(page)).includes(SECRET_URL), "One-time secret remained after closing reveal");
    await waitForApiCount(requests, requestCountBeforeSetup + 2);
    await page.waitForFunction(() => !document.querySelector('[class*="animate-pulse"]'));

    // Enabled rotation, disabling, and disabled rotation all explain destructive behavior.
    await clickText(page, "button", "Rotate", 0);
    await waitForText(page, "The prior credential will be invalidated.");
    await waitForText(page, "A new secret will be shown once");
    await clickText(page, "button", "Cancel");

    await clickText(page, "button", "Disable", 0);
    await waitForText(page, "New deliveries using this credential will stop.");
    await waitForText(page, "This does not delete receipt evidence.");
    const requestCountBeforeDisable = requests.length;
    await clickText(page, "button", "Confirm disable");
    await page.waitForFunction(() => !document.body.innerText.includes("Disable credential?"));
    await waitForApiCount(requests, requestCountBeforeDisable + 2);
    await page.waitForFunction(() => !document.querySelector('[class*="animate-pulse"]'));
    assert.deepEqual(patchBodies.at(-1), {
      id: CONNECTION_ENABLED_ID,
      action: "disable",
      confirmedBaseUrl: baseUrl,
    });

    await clickText(page, "button", "Rotate & re-enable", 0);
    await waitForText(page, "Rotate and re-enable credential?");
    await waitForText(page, "distribute it only through an approved secure channel");
    const requestCountBeforeRotate = requests.length;
    await clickText(page, "button", "Confirm rotate");
    await waitForText(page, "One-time credential reveal");
    assert.equal(patchBodies.at(-1).id, CONNECTION_ENABLED_ID);
    assert.equal(patchBodies.at(-1).action, "rotate");
    await clickText(page, "button", "I copied it");
    await waitForApiCount(requests, requestCountBeforeRotate + 2);
    await page.waitForFunction(() => !document.querySelector('[class*="animate-pulse"]'));

    // Pagination uses API page parameters and returns to page one.
    await clickText(page, "button", "Next");
    await waitForText(page, "Page 2");
    assert.equal(new URL([...requests].reverse().find(item => item.method === "GET").url).searchParams.get("page"), "2");
    await clickText(page, "button", "Previous");
    await waitForText(page, "Page 1");

    // Loading, empty, generic failure, and forbidden states are browser-rendered from mocked API responses.
    nextGet = { delay: 600 };
    await clickText(page, "button", "Refresh");
    await page.waitForSelector('[class*="animate-pulse"]');
    await page.waitForFunction(() => !document.querySelector('[class*="animate-pulse"]'));

    nextGet = { empty: true };
    await clickText(page, "button", "Refresh");
    await waitForText(page, "No AppFueled URL feeds match this view.");
    await waitForText(page, "No receipts matched the selected 30-day window.");

    nextGet = { status: 500, body: { error: "Synthetic browser API failure" } };
    await clickText(page, "button", "Refresh");
    await waitForText(page, "Synthetic browser API failure");

    nextGet = { status: 403, body: { error: "forbidden" } };
    await clickText(page, "button", "Refresh");
    await waitForText(page, "Platform operator access required");
    assert.ok((await text(page)).includes("rejected this session"));

    assert.ok(requests.length > 0);
    console.log(`PASS appfueled-url-events browser interactions (${requests.length} intercepted API requests)`);
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});