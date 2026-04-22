let coachPanel = null;
let coachData = null;
let coachMinimized = false;
let coachVisible = false;
let lastCoachVin = null;
let lastCoachRoId = null;

const COACH_STYLES = {
  panel: {
    position: "fixed",
    right: "16px",
    top: "80px",
    width: "340px",
    maxHeight: "calc(100vh - 120px)",
    backgroundColor: "#1a1a2e",
    color: "#e0e0e0",
    borderRadius: "12px",
    boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
    zIndex: "99998",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    fontSize: "13px",
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
    transition: "all 0.3s ease",
    border: "1px solid rgba(255,255,255,0.1)",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "12px 16px",
    background: "linear-gradient(135deg, #16213e 0%, #1a1a2e 100%)",
    borderBottom: "1px solid rgba(255,255,255,0.08)",
    cursor: "move",
    userSelect: "none",
  },
  headerTitle: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    fontWeight: "600",
    fontSize: "14px",
    color: "#fff",
  },
  scoreCircle: {
    width: "32px",
    height: "32px",
    borderRadius: "50%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontWeight: "700",
    fontSize: "12px",
    color: "#fff",
    flexShrink: "0",
  },
  body: {
    overflowY: "auto",
    maxHeight: "calc(100vh - 200px)",
    padding: "0",
  },
  vehicleBar: {
    padding: "8px 16px",
    backgroundColor: "rgba(255,255,255,0.04)",
    borderBottom: "1px solid rgba(255,255,255,0.06)",
    fontSize: "12px",
    color: "#aaa",
  },
  section: {
    padding: "8px 16px 4px",
    fontSize: "11px",
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: "0.5px",
  },
  taskRow: {
    display: "flex",
    alignItems: "flex-start",
    gap: "10px",
    padding: "8px 16px",
    borderBottom: "1px solid rgba(255,255,255,0.04)",
    transition: "background 0.15s",
  },
  dot: {
    width: "8px",
    height: "8px",
    borderRadius: "50%",
    flexShrink: "0",
    marginTop: "4px",
  },
  taskName: {
    fontWeight: "500",
    fontSize: "13px",
    color: "#e0e0e0",
    lineHeight: "1.3",
  },
  taskDetail: {
    fontSize: "11px",
    color: "#999",
    lineHeight: "1.4",
    marginTop: "2px",
  },
  minimizedBar: {
    position: "fixed",
    right: "16px",
    top: "80px",
    backgroundColor: "#1a1a2e",
    color: "#fff",
    borderRadius: "8px",
    padding: "8px 14px",
    cursor: "pointer",
    zIndex: "99998",
    boxShadow: "0 4px 16px rgba(0,0,0,0.3)",
    display: "flex",
    alignItems: "center",
    gap: "8px",
    fontSize: "13px",
    fontWeight: "500",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    border: "1px solid rgba(255,255,255,0.1)",
    transition: "all 0.2s ease",
  },
};

const STATUS_COLORS = {
  overdue: "#ef4444",
  due_soon: "#f59e0b",
  upcoming: "#22c55e",
  ok: "#22c55e",
  unknown: "#6b7280",
};

const STATUS_LABELS = {
  overdue: "Overdue",
  due_soon: "Due Soon",
  upcoming: "OK",
  ok: "OK",
  unknown: "—",
};

function createCoachPanel(data) {
  removeCoachPanel();
  coachData = data;
  coachMinimized = false;
  coachVisible = true;

  const panel = document.createElement("div");
  panel.id = "mos-vhi-coach-panel";
  applyStyles(panel, COACH_STYLES.panel);

  const header = document.createElement("div");
  applyStyles(header, COACH_STYLES.header);
  makeDraggable(panel, header);

  const titleGroup = document.createElement("div");
  applyStyles(titleGroup, COACH_STYLES.headerTitle);

  if (data.score) {
    const scoreCircle = document.createElement("div");
    applyStyles(scoreCircle, COACH_STYLES.scoreCircle);
    scoreCircle.style.backgroundColor = data.score.color || "#6b7280";
    scoreCircle.textContent = data.score.value || "?";
    titleGroup.appendChild(scoreCircle);
  }

  const titleText = document.createElement("span");
  titleText.textContent = "VHI Coach";
  titleGroup.appendChild(titleText);

  header.appendChild(titleGroup);

  const btnGroup = document.createElement("div");
  btnGroup.style.display = "flex";
  btnGroup.style.gap = "4px";

  const minBtn = createHeaderBtn("−", () => {
    minimizeCoach();
  });
  const closeBtn = createHeaderBtn("×", () => {
    removeCoachPanel();
  });

  btnGroup.appendChild(minBtn);
  btnGroup.appendChild(closeBtn);
  header.appendChild(btnGroup);
  panel.appendChild(header);

  if (data.vehicle) {
    const vBar = document.createElement("div");
    applyStyles(vBar, COACH_STYLES.vehicleBar);
    const parts = [data.vehicle.year, data.vehicle.make, data.vehicle.model].filter(Boolean);
    let vehicleText = parts.join(" ");
    if (data.currentMiles) {
      vehicleText += ` · ${Number(data.currentMiles).toLocaleString()} mi`;
    }
    vBar.textContent = vehicleText;
    panel.appendChild(vBar);
  }

  const body = document.createElement("div");
  applyStyles(body, COACH_STYLES.body);

  const overdue = data.taskMatches.filter((t) => t.status === "overdue");
  const dueSoon = data.taskMatches.filter((t) => t.status === "due_soon");
  const upcoming = data.taskMatches.filter((t) => t.status === "upcoming" || t.status === "ok");
  const unmatched = data.taskMatches.filter((t) => t.status === "unknown");

  if (overdue.length > 0) {
    body.appendChild(createSection(`Overdue (${overdue.length})`, STATUS_COLORS.overdue));
    overdue.forEach((t) => body.appendChild(createTaskRow(t)));
  }

  if (dueSoon.length > 0) {
    body.appendChild(createSection(`Due Soon (${dueSoon.length})`, STATUS_COLORS.due_soon));
    dueSoon.forEach((t) => body.appendChild(createTaskRow(t)));
  }

  if (upcoming.length > 0) {
    body.appendChild(createSection(`OK (${upcoming.length})`, STATUS_COLORS.upcoming));
    upcoming.forEach((t) => body.appendChild(createTaskRow(t)));
  }

  if (unmatched.length > 0) {
    const unmatchedSection = createSection(`Unmatched (${unmatched.length})`, STATUS_COLORS.unknown);
    body.appendChild(unmatchedSection);

    const unmatchedContainer = document.createElement("div");
    unmatchedContainer.style.padding = "4px 16px 8px";
    unmatchedContainer.style.fontSize = "11px";
    unmatchedContainer.style.color = "#666";
    unmatchedContainer.style.lineHeight = "1.6";
    unmatchedContainer.textContent = unmatched.map((t) => t.taskName).join(", ");
    body.appendChild(unmatchedContainer);
  }

  if (data.taskMatches.length === 0 || (overdue.length === 0 && dueSoon.length === 0 && upcoming.length === 0)) {
    const empty = document.createElement("div");
    empty.style.padding = "24px 16px";
    empty.style.textAlign = "center";
    empty.style.color = "#888";
    empty.textContent = "No VHI data matched to inspection tasks";
    body.appendChild(empty);
  }

  const summaryBar = document.createElement("div");
  Object.assign(summaryBar.style, {
    padding: "10px 16px",
    borderTop: "1px solid rgba(255,255,255,0.08)",
    display: "flex",
    justifyContent: "space-between",
    fontSize: "11px",
    color: "#888",
    backgroundColor: "rgba(255,255,255,0.02)",
  });
  summaryBar.innerHTML = `<span>${data.summary.matched} of ${data.summary.totalTasks} matched</span><span>Score: ${data.score?.value ?? "—"} (${data.score?.tier ?? "—"})</span>`;
  
  panel.appendChild(body);
  panel.appendChild(summaryBar);
  document.body.appendChild(panel);
  coachPanel = panel;
}

function createSection(label, color) {
  const section = document.createElement("div");
  applyStyles(section, COACH_STYLES.section);
  section.style.color = color;
  section.textContent = label;
  return section;
}

function createTaskRow(task) {
  const row = document.createElement("div");
  applyStyles(row, COACH_STYLES.taskRow);

  row.addEventListener("mouseenter", () => {
    row.style.backgroundColor = "rgba(255,255,255,0.04)";
  });
  row.addEventListener("mouseleave", () => {
    row.style.backgroundColor = "transparent";
  });

  const dot = document.createElement("div");
  applyStyles(dot, COACH_STYLES.dot);
  dot.style.backgroundColor = STATUS_COLORS[task.status] || STATUS_COLORS.unknown;
  row.appendChild(dot);

  const textCol = document.createElement("div");
  textCol.style.flex = "1";
  textCol.style.minWidth = "0";

  const name = document.createElement("div");
  applyStyles(name, COACH_STYLES.taskName);
  name.textContent = task.taskName;
  textCol.appendChild(name);

  if (task.recommendation) {
    const detail = document.createElement("div");
    applyStyles(detail, COACH_STYLES.taskDetail);
    detail.textContent = task.recommendation;
    textCol.appendChild(detail);
  }

  if (task.lastPerformedMiles || task.lastPerformedDate) {
    const lastInfo = document.createElement("div");
    applyStyles(lastInfo, COACH_STYLES.taskDetail);
    const parts = [];
    if (task.lastPerformedMiles) parts.push(`Last: ${Number(task.lastPerformedMiles).toLocaleString()} mi`);
    if (task.lastPerformedDate) {
      const d = new Date(task.lastPerformedDate);
      if (!isNaN(d.getTime())) parts.push(d.toLocaleDateString());
    }
    lastInfo.textContent = parts.join(" · ");
    textCol.appendChild(lastInfo);
  }

  row.appendChild(textCol);

  const badge = document.createElement("span");
  Object.assign(badge.style, {
    fontSize: "10px",
    fontWeight: "600",
    padding: "2px 6px",
    borderRadius: "4px",
    backgroundColor: STATUS_COLORS[task.status] + "22",
    color: STATUS_COLORS[task.status],
    whiteSpace: "nowrap",
    flexShrink: "0",
    marginTop: "2px",
  });
  badge.textContent = STATUS_LABELS[task.status] || "—";
  row.appendChild(badge);

  return row;
}

function minimizeCoach() {
  if (coachPanel) coachPanel.remove();
  coachMinimized = true;

  const bar = document.createElement("div");
  bar.id = "mos-vhi-coach-minimized";
  applyStyles(bar, COACH_STYLES.minimizedBar);

  const overdueCount = coachData?.summary?.overdue || 0;
  const dueSoonCount = coachData?.summary?.dueSoon || 0;

  let badgeColor = "#22c55e";
  if (overdueCount > 0) badgeColor = "#ef4444";
  else if (dueSoonCount > 0) badgeColor = "#f59e0b";

  bar.innerHTML = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${badgeColor}"></span>
    <span>VHI Coach</span>
    <span style="color:#888;font-size:11px">${overdueCount > 0 ? overdueCount + " overdue" : dueSoonCount > 0 ? dueSoonCount + " due soon" : "All OK"}</span>`;

  bar.addEventListener("click", () => {
    bar.remove();
    if (coachData) createCoachPanel(coachData);
  });

  bar.addEventListener("mouseenter", () => {
    bar.style.opacity = "0.9";
  });
  bar.addEventListener("mouseleave", () => {
    bar.style.opacity = "1";
  });

  document.body.appendChild(bar);
}

function removeCoachPanel() {
  const existing = document.getElementById("mos-vhi-coach-panel");
  if (existing) existing.remove();
  const minimized = document.getElementById("mos-vhi-coach-minimized");
  if (minimized) minimized.remove();
  coachPanel = null;
  coachVisible = false;
  coachMinimized = false;
}

function createHeaderBtn(text, onClick) {
  const btn = document.createElement("button");
  Object.assign(btn.style, {
    background: "none",
    border: "none",
    color: "#999",
    cursor: "pointer",
    fontSize: "16px",
    fontWeight: "bold",
    padding: "0 4px",
    lineHeight: "1",
    transition: "color 0.15s",
  });
  btn.textContent = text;
  btn.addEventListener("mouseenter", () => {
    btn.style.color = "#fff";
  });
  btn.addEventListener("mouseleave", () => {
    btn.style.color = "#999";
  });
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return btn;
}

function makeDraggable(panel, handle) {
  let isDragging = false;
  let startX, startY, startRight, startTop;

  handle.addEventListener("mousedown", (e) => {
    isDragging = true;
    startX = e.clientX;
    startY = e.clientY;
    startRight = parseInt(panel.style.right) || 16;
    startTop = parseInt(panel.style.top) || 80;
    e.preventDefault();
  });

  document.addEventListener("mousemove", (e) => {
    if (!isDragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    panel.style.right = Math.max(0, startRight - dx) + "px";
    panel.style.top = Math.max(0, startTop + dy) + "px";
  });

  document.addEventListener("mouseup", () => {
    isDragging = false;
  });
}

function applyStyles(el, styles) {
  Object.assign(el.style, styles);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "VHI_COACH_DATA") {
    if (message.data && message.data.success) {
      createCoachPanel(message.data);
    } else if (message.data && message.data.disabled) {
      // Feature was turned off for this shop — clear any stale panel so the
      // tech doesn't keep seeing yesterday's data.
      removeCoachPanel();
    }
    sendResponse({ success: true });
    return false;
  }

  if (message.action === "VHI_COACH_HIDE") {
    removeCoachPanel();
    sendResponse({ success: true });
    return false;
  }
});
