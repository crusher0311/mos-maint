// Display-only, current-order evidence. Never scan arbitrary objects or vehicle/history data.
(function (root) {
  const common = ['0W-8', '0W-16', '0W-20', '0W-30', '0W-40', '5W-20', '5W-30', '5W-40', '10W-30', '10W-40', '15W-40', '20W-50'];
  function normalize(value) {
    if (typeof value !== 'string' || value.length > 24) return null;
    const text = value.replace(/[–—‑]/g, '-').trim();
    if (/[^a-zA-Z0-9 \-]/.test(value.replace(/[–—‑]/g, '-'))) return null;
    const grade = text.match(/^(?:SAE\s*)?(\d{1,2})\s*W\s*-?\s*(\d{1,2})$/i);
    const single = text.match(/^SAE\s*(\d{1,2})$/i);
    return grade ? `${Number(grade[1])}W-${Number(grade[2])}` : single ? `SAE ${Number(single[1])}` : text;
  }
  function extract(lines) {
    if (!Array.isArray(lines) || lines.length > 500) return '';
    const grades = new Set();
    for (const line of lines) {
      if (typeof line !== 'string' || line.length > 1000) continue;
      if (!/\b(?:engine oil|motor oil|oil (?:and filter |& filter )?change|lube oil filter)\b/i.test(line)) continue;
      // Mixed-fluid, recommendations and alternatives are not reliable engine-oil evidence.
      if (/\b(?:gear|transmission|differential|transfer case|ATF|recommended|recommend|history|previous|declined|not|without|avoid|specification|specs)\b/i.test(line)) continue;
      for (const m of line.matchAll(/\b(\d{1,2})\s*W\s*[-–]?\s*(\d{1,2})\b/gi)) {
        const grade = `${Number(m[1])}W-${Number(m[2])}`;
        if (Number(m[1]) <= 25 && [8,12,16,20,30,40,50,60].includes(Number(m[2]))) grades.add(grade);
      }
      for (const m of line.matchAll(/\bSAE\s*(20|30|40|50|60)\b(?!\s*W)/gi)) grades.add(`SAE ${m[1]}`);
    }
    return grades.size === 1 ? [...grades][0] : '';
  }
  function tekmetricLines(ro) {
    if (!Array.isArray(ro?.jobs)) return [];
    return ro.jobs.slice(0, 500).flatMap(job => {
      if (job?.authorized === false || job?.declined === true) return [];
      // Keep the decline precedence of resolveTekmetricJobStatus in
      // lib/integrations/tekmetric/normalized-payload.ts, including status-only
      // payloads and a decline that contradicts authorized:true.
      const statuses = [job?.status, job?.jobStatus, job?.authorizationStatus]
        .filter(value => value !== null && value !== undefined && value !== '')
        .map(value => String(value).trim().toLowerCase().replace(/[\s-]+/g, '_'));
      if (statuses.some(status => status === 'declined' || status === 'deferred')) return [];
      const title = typeof job?.name === 'string' ? job.name : '';
      const parts = Array.isArray(job?.parts) ? job.parts : [];
      return [title, ...parts.slice(0, 100).map(part => `${title} ${typeof part?.name === 'string' ? part.name : ''}`)];
    });
  }
  function draft(previous, key, automatic, manual) {
    const same = previous?.key === key;
    if (manual !== undefined) return { key, value: normalize(manual) ?? '', edited: true };
    return same && previous.edited ? previous : { key, value: automatic || '', edited: false };
  }
  root.MosStickerViscosity = Object.freeze({ common, normalize, extract, tekmetricLines, draft });
})(globalThis);
