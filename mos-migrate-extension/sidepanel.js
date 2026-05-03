// MOS Migrate side panel — owner-only Tekmetric Shop Migration wizard.
//
// All wizard logic lives here; the background script is just an auth +
// API proxy + Tekmetric token relay. The server-side orchestrator at
// /api/extension/tekmetric-migration/* does the real work.

// ==================== STATE ====================
let isAuthenticated = false;
let mosShops = [];

const MIG = {
  runId: null,
  sourceShopId: null,
  destShopId: null,
  lastDump: null,
  lastCorePlan: null,
  lastCoreResult: null,
  lastExtrasResult: null,
};

// ==================== DOM ====================
const elements = {
  loadingState: document.getElementById('loading-state'),
  loginState: document.getElementById('login-state'),
  deniedState: document.getElementById('denied-state'),
  mainState: document.getElementById('main-state'),
  loginForm: document.getElementById('login-form'),
  emailInput: document.getElementById('email'),
  passwordInput: document.getElementById('password'),
  apiUrlInput: document.getElementById('api-url'),
  rememberMeCheckbox: document.getElementById('remember-me'),
  loginError: document.getElementById('login-error'),
  logoutBtn: document.getElementById('logout-btn'),
  deniedLogout: document.getElementById('denied-logout'),
  signedInAs: document.getElementById('signed-in-as'),
};

// ==================== UTILITIES ====================
function sendMessage(message, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      resolve({ error: 'Request timed out. Please try again.' });
    }, timeoutMs);
    chrome.runtime.sendMessage(message, (response) => {
      clearTimeout(timeout);
      if (chrome.runtime.lastError) {
        resolve({ error: chrome.runtime.lastError.message || 'Extension error' });
      } else {
        resolve(response || {});
      }
    });
  });
}

function migEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

async function migApi(endpoint, options = {}) {
  const result = await sendMessage({
    action: 'MOS_API_REQUEST',
    endpoint,
    options: {
      method: options.method || 'GET',
      body: options.body ? JSON.stringify(options.body) : undefined,
    },
  });
  if (result && result.success === false) {
    throw new Error(result.error || 'Migration API error');
  }
  if (result && result.error) {
    throw new Error(result.error);
  }
  return result;
}

// ==================== STATE TRANSITIONS ====================
function showLoading() {
  elements.loadingState.classList.remove('hidden');
  elements.loginState.classList.add('hidden');
  elements.deniedState.classList.add('hidden');
  elements.mainState.classList.add('hidden');
}
function showLogin() {
  elements.loadingState.classList.add('hidden');
  elements.loginState.classList.remove('hidden');
  elements.deniedState.classList.add('hidden');
  elements.mainState.classList.add('hidden');
}
function showDenied() {
  elements.loadingState.classList.add('hidden');
  elements.loginState.classList.add('hidden');
  elements.deniedState.classList.remove('hidden');
  elements.mainState.classList.add('hidden');
}
function showMain(user) {
  elements.loadingState.classList.add('hidden');
  elements.loginState.classList.add('hidden');
  elements.deniedState.classList.add('hidden');
  elements.mainState.classList.remove('hidden');
  if (user?.email && elements.signedInAs) {
    elements.signedInAs.textContent = `· ${user.email}`;
  }
  initMigrateWizard();
}

// ==================== INIT ====================
async function init() {
  const auth = await sendMessage({ action: 'GET_MOS_AUTH' });
  if (auth.isAuthenticated && auth.user?.isSuperAdmin === true) {
    isAuthenticated = true;
    mosShops = auth.shops || [];
    showMain(auth.user);
  } else if (auth.isAuthenticated && !auth.user?.isSuperAdmin) {
    // Stale cached non-owner session — purge and force a clean login.
    await sendMessage({ action: 'MOS_LOGOUT' });
    showLogin();
  } else {
    showLogin();
  }
  setupEventListeners();
}

function setupEventListeners() {
  elements.loginForm.addEventListener('submit', handleLogin);
  elements.logoutBtn?.addEventListener('click', handleLogout);
  elements.deniedLogout?.addEventListener('click', handleLogout);
}

async function handleLogin(e) {
  e.preventDefault();
  const email = elements.emailInput.value;
  const password = elements.passwordInput.value;
  const apiUrl = elements.apiUrlInput.value || 'https://mos.tools';
  const rememberMe = elements.rememberMeCheckbox.checked;

  elements.loginError.classList.add('hidden');
  const submitBtn = elements.loginForm.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Signing in...';

  try {
    const result = await sendMessage({
      action: 'MOS_LOGIN', email, password, apiUrl, rememberMe
    });

    if (result.notAuthorized) {
      showDenied();
      return;
    }
    if (result.success) {
      isAuthenticated = true;
      mosShops = result.shops || [];
      showMain(result.user);
    } else {
      throw new Error(result.error || 'Login failed');
    }
  } catch (err) {
    elements.loginError.textContent = err.message;
    elements.loginError.classList.remove('hidden');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Sign In';
  }
}

async function handleLogout() {
  await sendMessage({ action: 'MOS_LOGOUT' });
  isAuthenticated = false;
  mosShops = [];
  MIG.runId = null;
  MIG.sourceShopId = null;
  MIG.destShopId = null;
  showLogin();
}

// ==================== MIGRATION WIZARD ====================
// Each phase maps 1:1 to a snippet under
// scripts/one-off/tekmetric-open-jobs-migration-2026-04-30/.

function migSetStatus(elId, msg, kind = 'info') {
  const el = document.getElementById(elId);
  if (!el) return;
  el.className = `migrate-status migrate-status-${kind}`;
  el.textContent = msg;
}

function migShowStep(n) {
  for (let i = 1; i <= 5; i++) {
    const s = document.getElementById(`migrate-step-${i}`);
    if (!s) continue;
    s.classList.toggle('hidden', i > n);
  }
}

function migTekmetricShops() {
  return (Array.isArray(mosShops) ? mosShops : [])
    .filter(s => s && s.provider === 'tekmetric' && s.smsShopId)
    .sort((a, b) => String(a.name || a.smsShopId).localeCompare(String(b.name || b.smsShopId)));
}

function migPopulateShopSelects() {
  const shops = migTekmetricShops();
  ['migrate-source-shop', 'migrate-dest-shop'].forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    const prev = sel.value;
    const opts = ['<option value="">— pick a shop —</option>']
      .concat(shops.map(s => {
        const label = s.name ? `${migEsc(s.name)} (${migEsc(s.smsShopId)})` : migEsc(s.smsShopId);
        return `<option value="${migEsc(s.smsShopId)}">${label}</option>`;
      }));
    sel.innerHTML = opts.join('');
    if (prev) sel.value = prev;
  });
  if (!shops.length) {
    const hint = document.querySelector('#migrate-step-1 .migrate-hint');
    if (hint) hint.textContent = 'No Tekmetric shops are linked to your account.';
  }
}

async function migRefreshTokenStatus() {
  const src = parseInt(document.getElementById('migrate-source-shop').value, 10);
  const dst = parseInt(document.getElementById('migrate-dest-shop').value, 10);
  await migOneTokenStatus(src, 'migrate-source-badge');
  await migOneTokenStatus(dst, 'migrate-dest-badge');
}

async function migOneTokenStatus(smsShopId, badgeId) {
  const badge = document.getElementById(badgeId);
  if (!badge) return;
  if (!Number.isFinite(smsShopId)) {
    badge.textContent = '— pick a shop —';
    badge.className = 'migrate-badge';
    return;
  }
  badge.textContent = 'checking…';
  badge.className = 'migrate-badge';
  try {
    const r = await migApi(`/api/extension/tekmetric-migration/token-status?smsShopId=${smsShopId}`);
    if (!r?.hasToken) {
      badge.textContent = 'no cached token — open shop tab once';
      badge.className = 'migrate-badge migrate-badge-bad';
      return;
    }
    const ageMin = Math.round((r.ageMs || 0) / 60000);
    badge.textContent = r.fresh ? `fresh (${ageMin}m)` : `stale (${ageMin}m) — re-open tab`;
    badge.className = `migrate-badge ${r.fresh ? 'migrate-badge-good' : 'migrate-badge-warn'}`;
  } catch (e) {
    badge.textContent = `error: ${e.message}`;
    badge.className = 'migrate-badge migrate-badge-bad';
  }
}

async function migLoadExistingRuns() {
  const wrap = document.getElementById('migrate-existing-runs');
  if (!wrap) return;
  try {
    const r = await migApi('/api/extension/tekmetric-migration/runs');
    const runs = r?.runs || [];
    if (!runs.length) { wrap.innerHTML = ''; return; }
    wrap.innerHTML = `
      <h5 class="migrate-section-h">Recent runs</h5>
      <ul class="migrate-run-list">
        ${runs.slice(0, 8).map(run => `
          <li>
            <button class="migrate-resume-btn" data-run-id="${migEsc(run.id)}"
                    data-source="${migEsc(run.sourceShopId)}" data-dest="${migEsc(run.destShopId)}">
              <span class="migrate-run-status migrate-run-status-${migEsc(run.status)}">${migEsc(run.status)}</span>
              <span>${migEsc(run.sourceShopId)} → ${migEsc(run.destShopId)}</span>
              <span class="migrate-run-date">${migEsc(new Date(run.createdAt).toLocaleString())}</span>
            </button>
          </li>
        `).join('')}
      </ul>
    `;
    wrap.querySelectorAll('.migrate-resume-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        MIG.runId = btn.dataset.runId;
        MIG.sourceShopId = parseInt(btn.dataset.source, 10);
        MIG.destShopId = parseInt(btn.dataset.dest, 10);
        document.getElementById('migrate-source-shop').value = String(MIG.sourceShopId);
        document.getElementById('migrate-dest-shop').value = String(MIG.destShopId);
        document.getElementById('migrate-run-id').textContent = MIG.runId;
        migShowStep(5);
        migRefreshAudit();
      });
    });
  } catch (e) {
    wrap.innerHTML = `<p class="migrate-status migrate-status-bad">Could not load runs: ${migEsc(e.message)}</p>`;
  }
}

async function migStartRun() {
  const src = parseInt(document.getElementById('migrate-source-shop').value, 10);
  const dst = parseInt(document.getElementById('migrate-dest-shop').value, 10);
  if (!Number.isFinite(src) || !Number.isFinite(dst)) {
    alert('Pick both a source and a destination shop.');
    return;
  }
  if (src === dst) {
    alert('Source and destination must differ.');
    return;
  }
  const r = await migApi('/api/extension/tekmetric-migration/runs', {
    method: 'POST',
    body: { sourceShopId: src, destShopId: dst },
  });
  MIG.runId = r.run.id;
  MIG.sourceShopId = src;
  MIG.destShopId = dst;
  document.getElementById('migrate-run-id').textContent = MIG.runId;
  migShowStep(2);
  migRefreshAudit();
}

async function migRefreshAudit() {
  if (!MIG.runId) return;
  try {
    const r = await migApi(`/api/extension/tekmetric-migration/runs/${MIG.runId}`);
    migRenderAuditLog(r.audit || []);
  } catch (e) {
    console.warn('[MOS Migrate] refreshAudit:', e);
  }
}

function migRenderDumpSummary(payload) {
  const c = payload.counts || {};
  const previewRows = (payload.preview || []).map(p => `
    <tr>
      <td>${migEsc(p.sourceRoNumber || p.sourceRoId)}</td>
      <td>${migEsc(p.customer || '')}</td>
      <td>${migEsc(p.vehicle || '')}</td>
      <td>${migEsc(p.vin || '')}</td>
      <td class="num">${migEsc(p.mileage ?? '')}</td>
      <td class="num">${migEsc(p.jobs ?? 0)}</td>
      <td class="num">${migEsc(p.concerns ?? 0)}</td>
      <td class="num">${migEsc(p.inspections ?? 0)}</td>
      ${p.dumpError ? `<td class="migrate-cell-bad">${migEsc(p.dumpError)}</td>` : '<td></td>'}
    </tr>
  `).join('');
  return `
    <div class="migrate-summary">
      <span>ROs: <b>${c.ros ?? 0}</b></span>
      <span>Jobs: <b>${c.jobs ?? 0}</b></span>
      <span>Concerns: <b>${c.concerns ?? 0}</b></span>
      <span>Inspections: <b>${c.inspections ?? 0}</b></span>
      <span>Dump errors: <b>${c.rosWithDumpError ?? 0}</b></span>
      <span>Listing errors: <b>${(payload.errors || []).length}</b></span>
    </div>
    <div class="migrate-table-scroll">
      <table class="migrate-table">
        <thead><tr><th>RO#</th><th>Customer</th><th>Vehicle</th><th>VIN</th><th class="num">Miles</th><th class="num">Jobs</th><th class="num">Concerns</th><th class="num">Insp</th><th>Error</th></tr></thead>
        <tbody>${previewRows || '<tr><td colspan="9"><em>No ROs in dump</em></td></tr>'}</tbody>
      </table>
    </div>
  `;
}

function migRenderLoadCorePlan(plan, isDryRun) {
  const willCreate = plan.rosWillCreate ?? 0;
  const needsOverrideCount = (plan.needsOverride || []).length;
  const previewRows = (plan.preview || []).map(p => `
    <tr>
      <td>${migEsc(p.sourceRo)}</td>
      <td>${migEsc(p.customer || '')}</td>
      <td>${migEsc(p.vehicle || '')}</td>
      <td class="num">${migEsc(p.jobs ?? 0)}</td>
      <td><span class="migrate-action migrate-action-${migEsc(p.status)}">${migEsc(p.status)}</span></td>
    </tr>
  `).join('');
  return `
    <div class="migrate-summary">
      <span>Total ROs: <b>${plan.rosInDump ?? 0}</b></span>
      <span>Will create: <b>${willCreate}</b></span>
      <span>Already migrated: <b>${plan.rosAlreadyMigrated ?? 0}</b></span>
      <span>Needs override: <b>${needsOverrideCount}</b></span>
      <span>Jobs to create: <b>${plan.jobsWillCreate ?? 0}</b></span>
      <span class="migrate-mode ${isDryRun ? 'dry' : 'live'}">${isDryRun ? 'DRY-RUN' : 'CONFIRMED'}</span>
    </div>
    <div class="migrate-table-scroll">
      <table class="migrate-table">
        <thead><tr><th>Source RO</th><th>Customer</th><th>Vehicle</th><th class="num">Jobs</th><th>Status</th></tr></thead>
        <tbody>${previewRows || '<tr><td colspan="5"><em>Nothing to do</em></td></tr>'}</tbody>
      </table>
    </div>
  `;
}

function migRenderLoadCoreResult(res) {
  const c = res.counts || {};
  const failRows = (res.failures || []).map(f => `
    <tr>
      <td>${migEsc(f.sourceRo || f.sourceRoId)}</td>
      <td>${migEsc(f.step || '')}</td>
      <td>${migEsc(f.error || '')}</td>
    </tr>
  `).join('');
  return `
    <div class="migrate-summary">
      <span>Created: <b>${c.successes ?? 0}</b></span>
      <span>Reused: <b>${c.reusedAlreadyMigrated ?? 0}</b></span>
      <span>Failed: <b>${c.failures ?? 0}</b></span>
    </div>
    ${failRows ? `
      <h5 class="migrate-section-h">Failures</h5>
      <div class="migrate-table-scroll">
        <table class="migrate-table">
          <thead><tr><th>RO</th><th>Step</th><th>Error</th></tr></thead>
          <tbody>${failRows}</tbody>
        </table>
      </div>
    ` : ''}
  `;
}

function migRenderExtrasResult(res) {
  const successes = res.successes || [];
  const inspections = successes.reduce((n, s) => n + (s.inspectionsCreated || 0), 0);
  const photos = successes.reduce((n, s) => n + (s.photosCreated || 0), 0);
  const photosFailed = successes.reduce((n, s) => n + (s.photosFailed || 0), 0);
  return `
    <div class="migrate-summary">
      <span>Inspections: <b>${inspections}</b></span>
      <span>Photos: <b>${photos}</b></span>
      <span>Photos failed: <b>${photosFailed}</b></span>
      <span>RO failures: <b>${(res.failures || []).length}</b></span>
    </div>
  `;
}

function migRenderAuditLog(rows) {
  const wrap = document.getElementById('migrate-audit-log');
  if (!wrap) return;
  if (!rows.length) { wrap.innerHTML = '<p class="migrate-empty">No activity yet.</p>'; return; }
  wrap.innerHTML = `
    <ul class="migrate-audit-list">
      ${rows.slice(0, 50).map(a => `
        <li>
          <span class="migrate-audit-ts">${migEsc(new Date(a.createdAt).toLocaleTimeString())}</span>
          <span class="migrate-audit-phase">${migEsc(a.phase)}</span>
          <span class="migrate-audit-action">${migEsc(a.action)}</span>
          ${a.details ? `<span class="migrate-audit-details">${migEsc(JSON.stringify(a.details).slice(0, 120))}</span>` : ''}
        </li>
      `).join('')}
    </ul>
  `;
}

function migRenderOverridesList() {
  const list = document.getElementById('migrate-overrides-list');
  if (!list) return;
  const overrides = (MIG.lastCorePlan?.needsOverride) || [];
  if (!overrides.length) {
    list.innerHTML = '<p class="migrate-empty">Nothing needs overrides. Run a load-core dry-run first.</p>';
    return;
  }
  list.innerHTML = overrides.map(o => `
    <div class="migrate-override-card" data-source-ro="${migEsc(o.sourceRoId)}">
      <div class="migrate-override-head">
        <b>RO ${migEsc(o.sourceRoNumber || o.sourceRoId)}</b>
        <span class="migrate-override-reason">${migEsc(o.reason || '')}</span>
      </div>
      ${o.candidates && o.candidates.length ? `
        <div class="migrate-override-candidates">
          <em>Candidates on dest:</em>
          <ul>${o.candidates.slice(0, 5).map(c => `
            <li>cust=${migEsc(c.destCustomerId)} veh=${migEsc(c.destVehicleId)} ${migEsc(c.label || '')}</li>
          `).join('')}</ul>
        </div>
      ` : ''}
      <div class="migrate-override-row">
        <label>Dest customer id<input type="number" data-field="destCustomerId" /></label>
        <label>Dest vehicle id<input type="number" data-field="destVehicleId" /></label>
        <label>Dest labor rate id<input type="number" data-field="destLaborRateId" placeholder="optional" /></label>
      </div>
      <button class="btn-secondary migrate-override-go" data-source-ro="${migEsc(o.sourceRoId)}">Clone with override</button>
    </div>
  `).join('');
  list.querySelectorAll('.migrate-override-go').forEach(btn => {
    btn.addEventListener('click', async () => {
      const card = btn.closest('.migrate-override-card');
      const sourceRoId = parseInt(card.dataset.sourceRo, 10);
      const get = f => {
        const v = card.querySelector(`[data-field="${f}"]`).value;
        return v ? parseInt(v, 10) : undefined;
      };
      const body = {
        sourceRoId,
        destCustomerId: get('destCustomerId'),
        destVehicleId: get('destVehicleId'),
        destLaborRateId: get('destLaborRateId'),
        confirm: true,
      };
      if (!body.destCustomerId || !body.destVehicleId) {
        alert('Customer and vehicle are required.');
        return;
      }
      btn.disabled = true; btn.textContent = 'Cloning…';
      try {
        await migApi(`/api/extension/tekmetric-migration/runs/${MIG.runId}/override-clone`, {
          method: 'POST', body,
        });
        btn.textContent = 'Done';
        card.classList.add('migrate-override-done');
        migRefreshAudit();
      } catch (e) {
        btn.disabled = false;
        btn.textContent = 'Clone with override';
        alert(`Override clone failed: ${e.message}`);
      }
    });
  });
}

let migrateWizardInited = false;
function initMigrateWizard() {
  if (migrateWizardInited) {
    // Re-populate shop selects in case mosShops changed via re-login.
    migPopulateShopSelects();
    migRefreshTokenStatus();
    migLoadExistingRuns();
    return;
  }
  migrateWizardInited = true;

  migPopulateShopSelects();
  migRefreshTokenStatus();
  migLoadExistingRuns();

  document.getElementById('migrate-refresh-tokens')?.addEventListener('click', () => {
    migPopulateShopSelects();
    migRefreshTokenStatus();
  });
  ['migrate-source-shop', 'migrate-dest-shop'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', migRefreshTokenStatus);
  });

  document.getElementById('migrate-start-run')?.addEventListener('click', async () => {
    try { await migStartRun(); } catch (e) { alert(`Start run failed: ${e.message}`); }
  });

  document.getElementById('migrate-run-dump')?.addEventListener('click', async () => {
    if (!MIG.runId) return;
    migSetStatus('migrate-dump-status', 'Dumping source shop…', 'info');
    try {
      const r = await migApi(`/api/extension/tekmetric-migration/runs/${MIG.runId}/dump`, { method: 'POST' });
      MIG.lastDump = r;
      document.getElementById('migrate-dump-preview').innerHTML = migRenderDumpSummary(r);
      migSetStatus('migrate-dump-status', `Dump complete — ${r.counts?.ros || 0} ROs.`, 'good');
      migShowStep(3);
      migRefreshAudit();
    } catch (e) {
      migSetStatus('migrate-dump-status', e.message, 'bad');
    }
  });

  document.getElementById('migrate-loadcore-dry')?.addEventListener('click', async () => {
    if (!MIG.runId) return;
    migSetStatus('migrate-loadcore-status', 'Planning…', 'info');
    const useDirect = document.getElementById('migrate-loadcore-direct-ids')?.checked === true;
    try {
      const r = await migApi(`/api/extension/tekmetric-migration/runs/${MIG.runId}/load-core`, {
        method: 'POST', body: { confirm: false, useSourceIdsDirect: useDirect },
      });
      MIG.lastCorePlan = r.plan;
      document.getElementById('migrate-loadcore-preview').innerHTML = migRenderLoadCorePlan(r.plan, true);
      migSetStatus('migrate-loadcore-status', 'Dry-run ready — review plan, then confirm or pick overrides.', 'good');
      migShowStep(5);
      migRenderOverridesList();
      migRefreshAudit();
    } catch (e) {
      migSetStatus('migrate-loadcore-status', e.message, 'bad');
    }
  });

  document.getElementById('migrate-loadcore-confirm')?.addEventListener('click', async () => {
    if (!MIG.runId) return;
    if (!confirm('Confirm: this will create ROs in the destination shop. Proceed?')) return;
    migSetStatus('migrate-loadcore-status', 'Loading core ROs…', 'info');
    const useDirect = document.getElementById('migrate-loadcore-direct-ids')?.checked === true;
    try {
      const r = await migApi(`/api/extension/tekmetric-migration/runs/${MIG.runId}/load-core`, {
        method: 'POST', body: { confirm: true, useSourceIdsDirect: useDirect },
      });
      MIG.lastCoreResult = r.result;
      document.getElementById('migrate-loadcore-preview').innerHTML = migRenderLoadCoreResult(r.result);
      migSetStatus('migrate-loadcore-status', 'Load-core complete.', 'good');
      migShowStep(5);
      migRefreshAudit();
    } catch (e) {
      migSetStatus('migrate-loadcore-status', e.message, 'bad');
    }
  });

  document.getElementById('migrate-extras-dry')?.addEventListener('click', async () => {
    if (!MIG.runId) return;
    migSetStatus('migrate-extras-status', 'Planning extras…', 'info');
    try {
      const r = await migApi(`/api/extension/tekmetric-migration/runs/${MIG.runId}/load-extras`, {
        method: 'POST', body: { confirm: false },
      });
      MIG.lastExtrasResult = r.result;
      document.getElementById('migrate-extras-preview').innerHTML = migRenderExtrasResult(r.result);
      migSetStatus('migrate-extras-status', 'Dry-run ready.', 'good');
      migRefreshAudit();
    } catch (e) {
      migSetStatus('migrate-extras-status', e.message, 'bad');
    }
  });

  document.getElementById('migrate-extras-confirm')?.addEventListener('click', async () => {
    if (!MIG.runId) return;
    if (!confirm('Confirm: this will copy inspections and photos to the destination shop. Proceed?')) return;
    migSetStatus('migrate-extras-status', 'Copying inspections/photos…', 'info');
    try {
      const r = await migApi(`/api/extension/tekmetric-migration/runs/${MIG.runId}/load-extras`, {
        method: 'POST', body: { confirm: true },
      });
      MIG.lastExtrasResult = r.result;
      document.getElementById('migrate-extras-preview').innerHTML = migRenderExtrasResult(r.result);
      migSetStatus('migrate-extras-status', 'Load-extras complete.', 'good');
      migRefreshAudit();
    } catch (e) {
      migSetStatus('migrate-extras-status', e.message, 'bad');
    }
  });
}

// Keep service worker alive while panel is open.
let keepAliveInterval = null;
function startKeepAlive() {
  if (keepAliveInterval) return;
  keepAliveInterval = setInterval(() => {
    chrome.runtime.sendMessage({ action: 'PING' }).catch(() => {});
  }, 20000);
}
startKeepAlive();

init();
