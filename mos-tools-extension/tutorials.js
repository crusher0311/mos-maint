// Shared, read-only guide content and presentation for both production surfaces.
// Deliberately no business APIs, simulated clicks, navigation, storage, or printing.
export const guides = [
  { id:'vhi', title:'Understand VHI recommendations', duration:'About 1 minute', features:['maintenance'],
    prerequisite:'Open a vehicle’s health report in MOS, or the VHI tab for a repair order in Detect Dog.',
    steps:[
      ['Confirm the vehicle', 'Check the vehicle, repair order and current mileage before interpreting recommendations.', '[data-tutorial="vhi"]', '#has-context'],
      ['Read the priorities', 'Needs attention and Due soon help organize the conversation. Review the supporting history and intervals; a recommendation is not a diagnosis.', '[data-tutorial="vhi-priorities"]', '#plan-content'],
      ['Review before acting', 'Check what is already on the estimate and what was previously performed or declined. Adding or sharing is always your decision and requires the appropriate access.', '[data-tutorial="vhi-priorities"]', '#overdue-section'],
      ['Keep control', 'This guide never adds services, refreshes data or shares a report. Exit and use the actual controls when you are ready.', '[data-tutorial="vhi"]', '#tab-plan'],
    ] },
  { id:'jobs', title:'Find jobs and service history', duration:'About 1 minute', features:['job_lookup'],
    prerequisite:'Open Job Lookup on an available vehicle screen, or choose Jobs in Detect Dog. Search and canned jobs depend on your shop’s access and integration.',
    steps:[
      ['Start with a specific search', 'Enter a service or vehicle description in the real search field when ready. Advancing this guide does not run a search.', '[data-tutorial="jobs"] input', '#job-search'],
      ['Read the evidence', 'Review returned job details and the source vehicle or repair order. Historical work is context, not proof the same work is needed now.', '[data-tutorial="jobs"]', '#lookup-results'],
      ['Check canned jobs separately', 'Where available, open Canned yourself to review your shop’s prepared jobs. No results or a missing tab can mean the integration or access is unavailable.', '[data-tutorial="jobs"]', '#subtab-canned'],
      ['Choose deliberately', 'Confirm the current RO, parts, labor and pricing before using an Add action. Basic and read-only sessions cannot add jobs. This guide never changes an estimate.', '[data-tutorial="jobs"]', '#tab-jobs'],
    ] },
  { id:'printing', title:'Prepare stickers and keytags', duration:'About 1 minute', features:['oil_sticker','keytags'],
    prerequisite:'Open Quick Sticker or a permitted print screen yourself. In Detect Dog, choose Print, then the available sticker or keytag section. Keytags require their own shop access and vehicle context.',
    steps:[
      ['Choose the right format', 'Use the actual sticker or keytag controls for the format you need. Available formats depend on your subscription and setup.', '[data-tutorial="printing"]', '#tab-sticker'],
      ['Check the details', 'For stickers, review mileage, distance units and oil interval. For keytags, confirm the customer, vehicle and RO. Missing information should be corrected before printing.', '[data-tutorial="printing"] input', '#sticker-mileage, #keytag-customer'],
      ['Review your print setup', 'Confirm your printer, label stock and shop settings. This guide does not change templates, QR settings, or printer selection.', '[data-tutorial="printing"]', '#sticker-form, #keytag-form'],
      ['Print only when ready', 'Exit the guide, then choose the actual Print control if the preview and details are correct. Finishing this guide never prints or creates a QR code.', '[data-tutorial="printing"]', '#sticker-print-btn, #keytag-print-btn'],
    ] },
];

export function validPayload(p) {
  return !!p && (p.personId === null || typeof p.personId === 'string') &&
    typeof p.persistent === 'boolean' && typeof p.canSave === 'boolean' &&
    typeof p.state?.noticeSeen === 'boolean' &&
    ['dismissed','completed'].every(k => Array.isArray(p.state[k]) && p.state[k].every(id => guides.some(g => g.id === id)));
}

export function createTutorials({ surface, request, getContext }) {
  const root = document.createElement('div');
  root.className = 'mos-help';
  document.body.append(root);
  let key = '', generation = 0, reads = 0, payload = null, identityVerified = false, error = false, loading = false;
  let panel = null, outline = null, notice = null, active = null, index = 0;
  let returnFocus = null, observer = null, frame = null;
  let snapshot = getContext();
  let destroyed = false;
  const allowed = g => g.features.some(f => snapshot.features.includes(f));
  const available = () => {
    const visible = id => [...document.querySelectorAll(`[data-tutorial="${id}"]`)].some(node => node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden');
    const preferred = surface === 'web' ? (visible('printing') ? 'printing' : visible('jobs') ? 'jobs' : snapshot.current) : snapshot.current;
    return guides.filter(allowed).sort((a,b) => Number(b.id === preferred) - Number(a.id === preferred));
  };
  function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  function button(text, handler, className) {
    const node = el('button', text, className);
    node.type = 'button'; node.addEventListener('click', handler);
    return node;
  }
  function clearTracking() {
    observer?.disconnect(); observer = null;
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    window.removeEventListener('resize', place);
    document.removeEventListener('scroll', place, true);
    outline?.remove(); outline = null;
  }
  function close(restore = true) {
    clearTracking(); panel?.remove(); panel = null; active = null;
    if (restore && returnFocus?.isConnected && returnFocus.getClientRects().length) returnFocus.focus();
  }
  function removeNotice() { notice?.remove(); notice = null; }
  function current(token) { return !destroyed && token === generation && JSON.stringify(getContext()) === key; }
  async function write(action, guide) {
    const token = generation;
    if (!payload?.canSave || !payload?.persistent || !payload?.personId) {
      if (guide && payload) payload.state[action === 'complete' ? 'completed' : 'dismissed'].push(guide);
      return null;
    }
    const expectedPerson = payload.personId;
    const result = await request('PUT', guide
      ? {action,guide,expectedPersonId:expectedPerson}
      : {action,expectedPersonId:expectedPerson});
    if (!current(token)) return null;
    if (!validPayload(result)) throw new Error('Tutorial preferences unavailable');
    if (result.personId !== expectedPerson) {
      reset(); throw new Error('Tutorial identity changed');
    }
    // Responses from concurrent additive actions cannot erase one another.
    result.state.completed = [...new Set([...payload.state.completed, ...result.state.completed])];
    result.state.dismissed = [...new Set([...payload.state.dismissed, ...result.state.dismissed])];
    result.state.noticeSeen ||= payload.state.noticeSeen;
    payload = result;
    return result;
  }
  async function load() {
    let token = generation;
    const read = ++reads;
    loading = true; error = false;
    if (panel && !active) renderBrowser();
    try {
      const result = await request('GET');
      if (!current(token) || read !== reads) return;
      if (!validPayload(result)) throw new Error('Tutorials unavailable');
      if (identityVerified && payload && (payload.personId !== result.personId || payload.canSave !== result.canSave || payload.persistent !== result.persistent)) {
        // GET is authoritative even when the host has not yet heard about an
        // account/permission switch (for example, a login in another tab).
        reset(); token = generation;
      } else if (payload) {
        result.state.completed = [...new Set([...payload.state.completed,...result.state.completed])];
        result.state.dismissed = [...new Set([...payload.state.dismissed,...result.state.dismissed])];
        result.state.noticeSeen ||= payload.state.noticeSeen;
      }
      payload = result; identityVerified = true; loading = false;
      if (panel && !active) renderBrowser();
      if (available().length && result.persistent && result.canSave && result.personId && !result.state.noticeSeen) {
        const claim = await write('notice');
        if (current(token) && !panel && claim?.showNotice === true) showNotice();
      }
    } catch {
      if (!current(token) || (read !== reads && token === generation)) return;
      loading = false; error = true;
      // An unsuccessful identity read must not keep another person's badges
      // visible. Reading guides remains safe; no saved preference is assumed.
      payload = {personId:null, persistent:false, canSave:false, state:{noticeSeen:false,dismissed:[],completed:[]}};
      identityVerified = false;
      if (active) close();
      if (panel && !active) renderBrowser();
    }
  }
  function showNotice() {
    removeNotice();
    notice = el('section', '', 'mos-help-notice');
    notice.setAttribute('aria-label','Tutorials are available');
    notice.append(el('p','Short guides are here when you need them. Find Help & tutorials anytime.'),
      button('Browse guides', () => { removeNotice(); open(); }),
      button('Dismiss', removeNotice));
    root.append(notice); // No focus, modal, or automatic walkthrough.
  }
  function makePanel() {
    const hadFocus = panel?.contains(document.activeElement);
    if (!panel) {
      returnFocus = document.activeElement;
      panel = el('section', '', 'mos-help-panel');
      panel.setAttribute('role','dialog');
      panel.setAttribute('aria-label','Help & tutorials');
      panel.tabIndex = -1;
      root.append(panel);
    }
    panel.replaceChildren();
    const header = el('div', '', 'mos-help-header');
    header.append(el('span','Help & tutorials','mos-help-eyebrow'), button('Exit', () => close()));
    panel.append(header);
    if (hadFocus) panel.focus();
  }
  function renderBrowser() {
    clearTracking(); active = null;
    makePanel();
    panel.append(el('h2','A little help, on your terms'),
      el('p','Choose a short guide. Nothing runs until you choose it, and your work stays unchanged.'));
    if (loading) {
      const skeleton = el('div','', 'mos-help-skeleton'); skeleton.setAttribute('role','status'); skeleton.setAttribute('aria-label','Loading tutorial preferences'); panel.append(skeleton);
    } else if (error) {
      const message = el('p','Your tutorial preferences could not be loaded. Guides are still available; progress may not be saved.');
      message.setAttribute('role','status');
      panel.append(message, button('Retry preferences', () => { void load(); }));
    } else if (payload && (!payload.persistent || !payload.canSave)) {
      panel.append(el('p','Guide progress is available for this session only.','mos-help-missing'));
    }
    const list = available();
    if (!list.length) panel.append(el('p','No guides match the features currently available here. Your usual Support access is unchanged.','mos-help-missing'));
    list.forEach(g => {
      const row = el('article','', 'mos-help-guide');
      // Do not flash cached personal badges while an open/focus identity read
      // is being verified (another tab may have changed the signed-in person).
      const completed = !loading && payload?.state.completed.includes(g.id);
      const dismissed = !loading && payload?.state.dismissed.includes(g.id);
      row.append(el('h3',g.title), el('small',`${g.duration} · ${g.steps.length} steps${completed ? ' · Completed' : dismissed ? ' · Dismissed' : ''}`),
        el('p',g.prerequisite),
        button(completed || dismissed ? 'Replay guide' : 'Start guide', () => start(g)));
      if (!dismissed) row.append(button('Not now', async () => {
        const token = generation;
        try { await write('dismiss',g.id); if (current(token) && panel) renderBrowser(); }
        catch { if (current(token) && panel) status('Could not save dismissal. You can retry or exit.'); }
      },'mos-help-dismiss'));
      panel.append(row);
    });
    panel.append(el('small','Need a person? Your existing Support and chat are still available.'));
  }
  function status(text) {
    if (!panel) return;
    panel.querySelector('[data-help-status]')?.remove();
    const message = el('p',text,'mos-help-missing');
    message.dataset.helpStatus = ''; message.setAttribute('role','status');
    panel.append(message);
  }
  function open() {
    if (!snapshot.authenticated) return;
    removeNotice(); renderBrowser(); void load(); panel?.focus();
  }
  function start(g) {
    if (!allowed(g)) return;
    active = g; index = 0; renderStep();
  }
  function renderStep() {
    clearTracking();
    makePanel();
    const step = active.steps[index];
    panel.append(el('small',`${active.title} · Step ${index + 1} of ${active.steps.length}`));
    const progress = el('div','','mos-help-progress');
    progress.setAttribute('role','progressbar');
    progress.setAttribute('aria-label','Guide progress');
    progress.setAttribute('aria-valuemin','0'); progress.setAttribute('aria-valuemax',String(active.steps.length));
    progress.setAttribute('aria-valuenow',String(index + 1));
    const fill = el('span'); fill.style.width = `${(index+1)/active.steps.length*100}%`; progress.append(fill);
    panel.append(progress, el('h2',step[0]), el('p',step[1]));
    const missing = el('p','','mos-help-missing'); missing.dataset.helpMissing = ''; missing.setAttribute('role','status'); panel.append(missing);
    const actions = el('div','','mos-help-actions');
    const back = button('Back', () => { index--; renderStep(); }); back.disabled = index === 0;
    const next = button(index === active.steps.length - 1 ? 'Finish guide' : 'Next', async () => {
      if (index < active.steps.length - 1) { index++; renderStep(); return; }
      const token = generation, id = active.id;
      next.disabled = true;
      try {
        await write('complete', id);
        if (current(token) && panel) { renderBrowser(); status('Guide finished. Replay it anytime.'); panel.focus(); }
      } catch {
        if (current(token) && panel) { status('Guide finished, but progress could not be saved. Retry Finish or exit.'); next.disabled = false; }
      }
    },'mos-help-primary');
    actions.append(back, button('All guides', () => { renderBrowser(); panel.focus(); }), next);
    panel.append(actions);
    outline = el('div','','mos-help-outline'); outline.setAttribute('aria-hidden','true'); root.append(outline);
    observer = new MutationObserver(records => {
      if (records.some(r => !root.contains(r.target))) schedulePlace();
    });
    observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['class','style','hidden','disabled']});
    window.addEventListener('resize',place);
    document.addEventListener('scroll',place,true);
    place(); panel.focus();
  }
  function schedulePlace() { if (frame === null) frame = requestAnimationFrame(() => { frame = null; place(); }); }
  function place() {
    if (!active || !panel || !outline) return;
    const selector = active.steps[index][surface === 'web' ? 2 : 3];
    const target = [...document.querySelectorAll(selector)].find(node => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth &&
        getComputedStyle(node).visibility !== 'hidden' && !node.closest('[aria-hidden="true"]');
    });
    const missing = panel.querySelector('[data-help-missing]');
    outline.hidden = !target;
    if (!target) {
      missing.textContent = `This control is not visible, is still loading, or is unavailable here. ${active.prerequisite} Exit to open it yourself, or continue reading. We will not open controls or fetch data for you.`;
      missing.hidden = false; panel.style.top = ''; panel.style.left = ''; return;
    }
    missing.hidden = true;
    const r = target.getBoundingClientRect();
    Object.assign(outline.style, {left:`${Math.max(0,r.left-3)}px`,top:`${Math.max(0,r.top-3)}px`,width:`${Math.min(r.width+6,innerWidth)}px`,height:`${Math.min(r.height+6,innerHeight)}px`});
    if (innerWidth >= 768) {
      const width = panel.getBoundingClientRect().width;
      const left = r.right + width + 24 < innerWidth ? r.right + 12 : Math.max(12,r.left-width-12);
      panel.style.left = `${Math.min(left,innerWidth-width-12)}px`;
      panel.style.top = `${Math.max(12,Math.min(r.top,innerHeight-panel.offsetHeight-12))}px`;
    } else { panel.style.left = ''; panel.style.top = ''; }
  }
  function reset() {
    generation++; reads++; payload = null; identityVerified = false; error = false; loading = false;
    close(); removeNotice();
  }
  function sync() {
    const next = getContext(), nextKey = JSON.stringify(next);
    if (nextKey === key || destroyed) return;
    reset(); snapshot = next; key = nextKey;
    if (next.authenticated) void load();
  }
  function onKey(event) {
    if (!panel) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
  }
  document.addEventListener('keydown',onKey,true);
  function onFocus() {
    if (destroyed) return;
    const before = key;
    sync();
    if (key === before && getContext().authenticated) void load();
  }
  window.addEventListener('focus',onFocus);
  sync();
  return { open, sync, reset, destroy() { reset(); destroyed = true; document.removeEventListener('keydown',onKey,true); window.removeEventListener('focus',onFocus); root.remove(); } };
}
