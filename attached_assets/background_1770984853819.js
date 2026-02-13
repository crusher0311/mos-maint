// SECTION 1: Capture Tekmetric token and shop ID from network request
let authToken = null;
let currentShopId = null;

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (details.url.includes("/api/token/shop/")) {
      const match = details.url.match(/shop\/(\d+)/);
      if (match) {
        currentShopId = match[1];
        console.log("[Token Watcher] Shop ID:", currentShopId);
      }

      const tokenHeader = details.requestHeaders.find(
        (h) => h.name.toLowerCase() === "x-auth-token"
      );
      if (tokenHeader) {
        authToken = tokenHeader.value;
        console.log("[Token Watcher] Token captured:", authToken);
      }
    }
  },
  {
    urls: ["https://sandbox.tekmetric.com/api/token/shop/*"],
    types: ["xmlhttprequest"]
  },
  ["requestHeaders"]
);

// SECTION 2: Listen for repair order load or creation and trigger labor rate update
let lastProcessedRoId = null;

const handleRepairOrder = async (details) => {
  if (!authToken || !currentShopId) return;

  let roId = null;
  let shopId = currentShopId;

  // matches when navigating to an existing repair order (e.g. via board or direct URL)
  const shopMatch = details.url.match(/\/sandbox\/(\d+)\/repair-order\/(\d+)/);
  if (shopMatch) {
    shopId = shopMatch[1];
    roId = shopMatch[2];
  }

  // matches when a new repair order is created
  const newRoMatch = details.url.match(/\/repair-order\/(\d+)\/estimate/);
  if (newRoMatch) {
    roId = newRoMatch[1];
  }

  if (!roId) return;

  if (lastProcessedRoId === roId) {
    console.log(`[RO Watcher] Skipping duplicate RO: ${roId}`);
    return;
  }

  lastProcessedRoId = roId;

  console.log("[RO Watcher] Repair order detected:", roId);

  try {
    // SECTION 2.1: Fetch the repair order details
    const getRes = await fetch(`https://sandbox.tekmetric.com/api/shop/${shopId}/repair-order/${roId}`, {
      headers: {
        "x-auth-token": authToken,
        "content-type": "application/json"
      }
    });

    if (!getRes.ok) {
      console.error(`[RO Watcher] Failed to fetch RO: ${getRes.status}`);
      return;
    }

    const roData = await getRes.json();

    const currentRate = roData.laborRate;
    const make = roData.vehicle?.make?.toLowerCase();
    console.log(`[RO Watcher] Current labor rate: ${currentRate}`);
    console.log(`[RO Watcher] Vehicle make: ${make}`);

    // SECTION 2.2: Load saved groups and find match
    const groups = await new Promise(resolve =>
      chrome.storage.local.get("laborRateGroups", res => resolve(res.laborRateGroups || []))
    );

    let matchedRate = null;

    for (const group of groups) {
      if (group.makes.some(m => m.toLowerCase() === make)) {
        matchedRate = group.laborRate;
        console.log(`[RO Watcher] Matched group '${group.name}' with rate: ${matchedRate}`);
        break;
      }
    }

    // SECTION 2.3: Apply labor rate if match is found and it's different
    if (matchedRate !== null && currentRate !== matchedRate) {
      const payload = {
        laborRate: matchedRate,
        appointmentOption: roData.appointmentOption,
        customerTimeIn: roData.customerTimeIn,
        customerTimeOut: roData.customerTimeOut,
        defaultTechnicianId: roData.defaultTechnicianId,
        keytag: roData.keytag,
        leadSource: roData.leadSource,
        notes: roData.notes,
        poNumber: roData.poNumber,
        referrerId: roData.referrerId,
        referrerName: roData.referrerName,
        saveCustomerParts: roData.saveCustomerParts,
        serviceWriterId: roData.serviceWriterId
      };

      const putRes = await fetch(`https://sandbox.tekmetric.com/api/repair-order/${roId}/summary`, {
        method: "PUT",
        headers: {
          "x-auth-token": authToken,
          "content-type": "application/json"
        },
        body: JSON.stringify(payload)
      });

      if (putRes.ok) {
        console.log(`[RO Watcher] Labor rate updated to $${(matchedRate / 100).toFixed(2)} for RO: ${roId}`);

        chrome.tabs.query({ url: "*://sandbox.tekmetric.com/*" }, (tabs) => {
          for (const tab of tabs) {
            chrome.tabs.sendMessage(tab.id, { type: "REFRESH_LABOR_RATE_UI" }, (res) => {
              if (chrome.runtime.lastError) {
                console.warn(`[RO Watcher] Content script not ready in tab ${tab.id}`);
              }
            });
          }
        });

      } else {
        console.error(`[RO Watcher] Failed to update labor rate: ${putRes.status}`);
      }

    } else {
      console.log(`[RO Watcher] No labor rate change needed for RO: ${roId}`);
    }

  } catch (err) {
    console.error("[RO Watcher] Error processing repair order:", err);
  }
};

chrome.webRequest.onCompleted.addListener(
  handleRepairOrder,
  {
    urls: [
      // this fires when navigating to an existing RO
      // "https://shop.tekmetric.com/api/shop*/repair-order/*", //

      // this fires when a new RO is created
      "https://sandbox.tekmetric.com/api/repair-order/*/estimate"
    ],
    types: ["xmlhttprequest"]
  }
);
