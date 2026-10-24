// Order-local launchers only. No provider writes or automatic printing.
(function (root) {
  function create({ document, send, getContext, now = Date.now }) {
    const id = 'mos-shopmonkey-actions';
    let scope = null;
    let generation = 0;
    let settings = null;
    let expires = 0;
    let pending = false;
    let layoutTarget = null;
    let priorWrap = '';
    const key = c => c?.provider === 'shopmonkey' && c.shopId && c.roId
      ? JSON.stringify([c.shopId, c.roId]) : null;
    const remove = () => {
      document.getElementById(id)?.remove();
      if (layoutTarget) layoutTarget.style.flexWrap = priorWrap;
      layoutTarget = null;
    };
    function anchor(c) {
      // Find the native Print toolbar within this order's header, not a
      // similarly named button in a menu, modal, or another open order.
      const tag = Array.from(document.querySelectorAll('[data-testid^="addLabelBtnOrder-"]'))
        .find(el => el.getAttribute('data-testid') === `addLabelBtnOrder-${c?.roId}`);
      for (let header = tag?.parentElement; header && header !== document.body; header = header.parentElement) {
        const buttons = Array.from(header.querySelectorAll('button[title="Print"]'))
          .filter(button => button.getClientRects().length > 0);
        if (!buttons.length) continue;
        if (buttons.length !== 1) return null;
        // Supplied markup: Print → split-button group → toolbar → actions.
        const actions = buttons[0].parentElement?.parentElement?.parentElement;
        return actions && actions !== header && header.contains(actions) ? actions : null;
      }
      return null;
    }
    function render() {
      const context = getContext();
      const target = anchor(context);
      const existing = document.getElementById(id);
      if (!scope || key(context) !== scope || !target || !settings || now() >= expires) {
        remove();
        return;
      }
      const visibility = settings.buttonVisibility?.shopmonkey;
      const launcher = settings.floatingButtonEnabled === true;
      const print = settings.features?.oil_sticker === true && visibility?.oil_sticker !== false;
      if (!launcher && !print) { remove(); return; }
      if (existing?.parentElement === target) return;
      remove();
      const group = document.createElement('span');
      group.id = id;
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', 'Detect Dog tools');
      group.style.cssText = 'display:flex;align-items:center;flex-wrap:wrap;gap:4px;flex:0 0 100%;width:100%';
      const status = document.createElement('span');
      status.setAttribute('role', 'status');
      status.style.cssText = 'font-size:12px;color:#b42318';
      function button(label, action) {
        const el = document.createElement('button');
        el.type = 'button';
        el.textContent = label;
        el.title = action === 'OPEN_STICKER_PANEL' ? 'Open Detect Dog Print tab' : 'Open Detect Dog';
        el.setAttribute('aria-label', el.title);
        el.style.cssText = 'height:24px;padding:0 8px;border:1px solid #bfdbfe;border-radius:4px;background:#eff6ff;color:#1d4ed8;font:500 12px system-ui;cursor:pointer';
        const mountedScope = scope;
        el.addEventListener('click', event => {
          event.preventDefault();
          event.stopPropagation();
          const current = getContext();
          if (key(current) !== mountedScope || !settings || now() >= expires) {
            invalidate();
            return;
          }
          // Send synchronously inside the gesture so Chrome can open the panel.
          send({ action, context: current }, response => {
            if (key(getContext()) !== mountedScope) return;
            status.textContent = response?.success
              ? '' : 'Could not open Detect Dog. Reload this page and try again.';
          });
        });
        group.appendChild(el);
      }
      if (launcher) button('Detect Dog', 'OPEN_SIDE_PANEL');
      if (print) button('Print', 'OPEN_STICKER_PANEL');
      group.appendChild(status);
      // Leave native controls and their DOM ownership intact. The full-width
      // flex item forms a new row below Print/Send/Message, aligned with Print.
      layoutTarget = target;
      priorWrap = target.style.flexWrap;
      target.style.flexWrap = 'wrap';
      target.appendChild(group);
    }
    function update() {
      const context = getContext();
      const next = key(context);
      if (next !== scope) {
        generation++;
        scope = next;
        settings = null;
        expires = 0;
        pending = false;
        remove();
      }
      render();
      if (!scope || !anchor(context) || (pending && now() < expires) || now() < expires) return;
      settings = null;
      pending = true;
      // Also bounds hung messages. A later update can retry after 10 seconds.
      expires = now() + 10000;
      const request = ++generation;
      send({ action: 'GET_SHOP_FEATURES', provider: 'shopmonkey', shopId: context.shopId }, response => {
        if (request !== generation || key(getContext()) !== scope) return;
        pending = false;
        settings = response?.success ? response : null;
        expires = now() + (settings ? 30000 : 10000);
        const eligibilityEnd = Date.parse(settings?.eligibility?.eligibleUntil);
        if (Number.isFinite(eligibilityEnd)) expires = Math.min(expires, eligibilityEnd);
        remove();
        render();
      });
    }
    function invalidate() {
      generation++;
      settings = null;
      expires = 0;
      pending = false;
      remove();
      update();
    }
    return { update, invalidate };
  }
  root.MosShopmonkeyButtons = { create };
  if (typeof module !== 'undefined') module.exports = { create };
})(globalThis);
