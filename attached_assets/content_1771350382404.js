// SECTION content.js

// SECTION 1: Listen for message to show loading overlay and reload
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "REFRESH_LABOR_RATE_UI") {
      // SECTION 1.1: Create overlay
      const overlay = document.createElement("div");
      overlay.id = "labor-rate-overlay";
      overlay.textContent = "Updating labor rate...";
      Object.assign(overlay.style, {
        position: "fixed",
        top: 0,
        left: 0,
        width: "100vw",
        height: "100vh",
        background: "rgba(0,0,0,0.7)",
        color: "white",
        fontSize: "2em",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 9999
      });
      document.body.appendChild(overlay);
  
      // SECTION 1.2: Trigger page reload
      setTimeout(() => {
        window.location.reload();
      }, 1000);
    }
  });
  
  // SECTION 2: Remove overlay after reload
  window.addEventListener("load", () => {
    const overlay = document.getElementById("labor-rate-overlay");
    if (overlay) {
      overlay.remove();
    }
  });
  