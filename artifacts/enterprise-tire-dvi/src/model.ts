export type Rating = 'not-inspected' | 'green' | 'yellow' | 'red' | 'not-applicable';
export type TreadUnit = '32nds' | 'mm';
export type BatteryResult = 'not-tested' | 'pass' | 'fail' | 'unable-to-test';
export type Standard = 'CCA' | 'CA' | 'EN' | 'DIN';
export type Media = { id: string; name: string; url: string; kind: 'image' | 'video' };
export type WheelId = 'LF' | 'RF' | 'LR' | 'RR';
export type Wheel = { id: WheelId; size: string; oeSize: string; inner: string; center: string; outer: string; unit: TreadUnit; beforePsi: string; afterPsi: string; rating: Rating; notes: string; media: Media[] };
export type Check = { id: string; name: string; group: string; mandatory: boolean; rating: Rating; notes: string; thickness: string; media: Media[] };
export type Battery = { rated: string; measured: string; ratedStandard: Standard; measuredStandard: Standard; result: BatteryResult; voltage: string; terminals: string; notes: string; media: Media[] };
export type Recommendation = { id: string; title: string; selected: boolean; part: string; quantity: string; unitPrice: string; labor: string; hours: string; laborRate: string };
export type DemoState = { wheels: Wheel[]; battery: Battery; checks: Check[]; recommendations: Recommendation[]; revision: number; completedRevision: number | null; reviewedRevision: number | null; handoffRevision: number | null };
export type InspectionLine = { id: string; title: string; rating: Rating | BatteryResult; details: string; notes: string; media: Media[]; mandatory: boolean; inspected: boolean };
export const WHEEL_NAMES: Record<WheelId, string> = { LF: 'Left front', RF: 'Right front', LR: 'Left rear', RR: 'Right rear' };
export const RATING_LABELS: Record<Rating | BatteryResult, string> = { 'not-inspected': 'Not inspected', green: 'Good · green', yellow: 'Monitor · yellow', red: 'Attention · red', 'not-applicable': 'Not applicable', pass: 'Pass · green', fail: 'Fail · red', 'not-tested': 'Not tested', 'unable-to-test': 'Unable to test' };
export const LIBRARY: { id: string; name: string; group: string }[] = [
  { id: 'brake-pads', name: 'Brake pads', group: 'Brakes' }, { id: 'brake-rotors', name: 'Brake rotors', group: 'Brakes' },
  { id: 'steering', name: 'Steering / suspension', group: 'Steering / suspension / alignment' }, { id: 'alignment', name: 'Alignment observations', group: 'Steering / suspension / alignment' },
  { id: 'fluids', name: 'Fluid levels', group: 'Fluids / leaks' }, { id: 'leaks', name: 'Visible leaks', group: 'Fluids / leaks' },
  { id: 'filter', name: 'Engine air filter', group: 'Filters / belts / hoses' }, { id: 'belts', name: 'Belts and hoses', group: 'Filters / belts / hoses' },
  { id: 'lights', name: 'Exterior lights', group: 'Lights / wipers' }, { id: 'wipers', name: 'Wiper condition', group: 'Lights / wipers' },
  { id: 'road-test', name: 'Road-test observations', group: 'Road-test / warning-light checks' }, { id: 'warning', name: 'Warning lights', group: 'Road-test / warning-light checks' },
];
export function createDemoState(): DemoState {
  return {
    wheels: (['LF', 'RF', 'LR', 'RR'] as WheelId[]).map(id => ({ id, size: id.endsWith('F') ? '225/45R18' : '255/40R18', oeSize: '', inner: '', center: '', outer: '', unit: '32nds', beforePsi: '', afterPsi: '', rating: 'not-inspected', notes: '', media: [] })),
    battery: { rated: '', measured: '', ratedStandard: 'CCA', measuredStandard: 'CCA', result: 'not-tested', voltage: '', terminals: '', notes: '', media: [] },
    checks: ['Wheel / lug condition', 'Visible tire sidewall condition'].map((name, i) => ({ id: `safety-${i}`, name, group: 'Fixed demo safety checks', mandatory: true, rating: 'not-inspected', notes: '', thickness: '', media: [] })),
    recommendations: [
      { id: 'tires', title: 'Rear tire replacement recommendation', selected: false, part: 'Touring tire · 255/40R18', quantity: '2', unitPrice: '187.45', labor: 'Mount and balance', hours: '0.8', laborRate: '119.50' },
      { id: 'alignment', title: 'Alignment recommendation', selected: false, part: 'No parts required', quantity: '0', unitPrice: '0', labor: 'Four-wheel alignment', hours: '1.1', laborRate: '119.50' },
      { id: 'battery', title: 'Battery replacement recommendation', selected: false, part: 'Group 48 battery', quantity: '1', unitPrice: '164.75', labor: 'Battery replacement', hours: '0.3', laborRate: '119.50' },
    ], revision: 0, completedRevision: null, reviewedRevision: null, handoffRevision: null,
  };
}
function numeric(value: string, min: number, max: number): boolean {
  return value.trim() !== '' && Number.isFinite(Number(value)) && Number(value) >= min && Number(value) <= max;
}
export function getCompletionErrors(state: DemoState): string[] {
  const errors: string[] = [];
  for (const w of state.wheels) {
    const name = WHEEL_NAMES[w.id];
    if (!['green', 'yellow', 'red'].includes(w.rating)) errors.push(`${name}: manually confirm a green, yellow or red rating.`);
    if (!w.size.trim()) errors.push(`${name}: enter the actual tire size.`);
    if (!['32nds', 'mm'].includes(w.unit) || ![w.inner, w.center, w.outer].every(v => numeric(v, 0, w.unit === '32nds' ? 32 : 25))) errors.push(`${name}: enter valid inner, center and outer tread (${w.unit === '32nds' ? '0–32 /32 in' : '0–25 mm'}).`);
    if (!numeric(w.beforePsi, 1, 120)) errors.push(`${name}: enter before pressure (1–120 PSI).`);
    if (w.afterPsi.trim() && !numeric(w.afterPsi, 1, 120)) errors.push(`${name}: after pressure must be 1–120 PSI or left blank.`);
  }
  const b = state.battery;
  if (b.result === 'not-tested') errors.push('Battery: record a manual pass/fail or explain unable to test.');
  if (b.result === 'unable-to-test' && !b.notes.trim()) errors.push('Battery: explain why the test could not be performed.');
  if (b.result === 'pass' || b.result === 'fail') {
    if (!numeric(b.rated, 1, 3000) || !numeric(b.measured, 1, 3000)) errors.push('Battery: enter rated and measured cranking values (1–3000).');
    if (b.ratedStandard !== b.measuredStandard) errors.push('Battery: rated and measured standards must match; do not compare unlike standards.');
  }
  if (b.voltage.trim() && !numeric(b.voltage, 0, 60)) errors.push('Battery: voltage must be 0–60 V or blank.');
  for (const c of state.checks) {
    if (c.mandatory && !['green', 'yellow', 'red'].includes(c.rating)) errors.push(`${c.name}: manually confirm a rating.`);
    if (c.thickness.trim() && !numeric(c.thickness, 0, 30)) errors.push(`${c.name}: brake-pad thickness must be 0–30 mm.`);
  }
  return errors;
}
export function getPricingErrors(state: DemoState): string[] {
  return state.recommendations.filter(r => r.selected).flatMap(r => {
    const errors: string[] = [];
    if (!r.title.trim() || !r.part.trim() || !r.labor.trim()) errors.push(`${r.id}: enter package, part and labor descriptions.`);
    if (!numeric(r.quantity, 0, 100) || !Number.isInteger(Number(r.quantity))) errors.push(`${r.title}: quantity must be a whole number from 0 to 100.`);
    if (![r.unitPrice, r.laborRate].every(v => numeric(v, 0, 10000)) || !numeric(r.hours, 0, 100)) errors.push(`${r.title}: enter nonnegative prices and labor hours (up to 100).`);
    return errors;
  });
}
export function recommendationTotal(r: Recommendation): number {
  const values = [r.quantity, r.unitPrice, r.hours, r.laborRate].map(Number);
  if (values.some(v => !Number.isFinite(v) || v < 0)) return 0;
  return Math.round(values[0] * Math.round(values[1] * 100) + values[2] * Math.round(values[3] * 100)) / 100;
}
export function ticketTotal(state: DemoState): number {
  return state.recommendations.filter(r => r.selected).reduce((sum, r) => sum + Math.round(recommendationTotal(r) * 100), 0) / 100;
}
export function composeInspectionLines(state: DemoState): InspectionLine[] {
  const lines: InspectionLine[] = state.wheels.map(w => ({
    id: `wheel-${w.id}`, title: `${WHEEL_NAMES[w.id]} tire`, rating: w.rating, mandatory: true, inspected: ['green', 'yellow', 'red'].includes(w.rating),
    details: `Actual size: ${w.size || 'Not recorded'}${w.oeSize ? ` · OE / placard reference: ${w.oeSize}` : ''}\nTread I / C / O: ${w.inner || '—'} / ${w.center || '—'} / ${w.outer || '—'} ${w.unit === '32nds' ? '/32 in' : 'mm'}\nPressure before: ${w.beforePsi || 'Not recorded'} PSI · after: ${w.afterPsi ? `${w.afterPsi} PSI` : 'Not recorded'}`,
    notes: w.notes, media: w.media,
  }));
  const b = state.battery;
  lines.push({ id: 'battery', title: 'Battery test documentation', rating: b.result, mandatory: true, inspected: b.result === 'pass' || b.result === 'fail', details: `Rated: ${b.rated || 'Not recorded'} ${b.ratedStandard} · measured: ${b.measured || 'Not recorded'} ${b.measuredStandard}${b.voltage ? `\nVoltage: ${b.voltage} V` : ''}${b.terminals ? `\nTerminals: ${b.terminals}` : ''}`, notes: b.notes, media: b.media });
  lines.push(...state.checks.map(c => ({ id: c.id, title: c.name, rating: c.rating, mandatory: c.mandatory, inspected: ['green', 'yellow', 'red'].includes(c.rating), details: c.thickness ? `Brake-pad thickness: ${c.thickness} mm` : 'Visual check documentation', notes: c.notes, media: c.media })));
  return lines;
}
export function isCompleted(s: DemoState): boolean { return s.completedRevision === s.revision && getCompletionErrors(s).length === 0; }
export function isReviewed(s: DemoState): boolean { return isCompleted(s) && s.reviewedRevision === s.revision && getPricingErrors(s).length === 0; }
export type DemoAction =
  | { type: 'wheel'; id: WheelId; patch: Partial<Omit<Wheel, 'id'>> }
  | { type: 'battery'; patch: Partial<Battery> }
  | { type: 'check'; id: string; patch: Partial<Omit<Check, 'id' | 'mandatory'>> }
  | { type: 'toggle-check'; id: string }
  | { type: 'recommendation'; id: string; patch: Partial<Omit<Recommendation, 'id'>> }
  | { type: 'complete' | 'review' | 'handoff' | 'reset' | 'sample-green' };
export type ActionResult = { ok: boolean; state: DemoState; message: string };
export function applyAction(state: DemoState, action: DemoAction): ActionResult {
  const fail = (message: string): ActionResult => ({ ok: false, state, message });
  const success = (next: DemoState, message = 'Demo updated.'): ActionResult => ({ ok: true, state: next, message });
  if (action.type === 'reset') return success(createDemoState(), 'Demo reset. All local evidence cleared.');
  if (action.type === 'complete') {
    const errors = getCompletionErrors(state);
    return errors.length ? fail(errors.join('\n')) : success({ ...state, completedRevision: state.revision, reviewedRevision: null, handoffRevision: null }, 'Inspection documentation complete. Ready for advisor review.');
  }
  if (action.type === 'review') {
    if (!isCompleted(state)) return fail('Complete the current inspection before advisor review.');
    const errors = getPricingErrors(state);
    return errors.length ? fail(errors.join('\n')) : success({ ...state, reviewedRevision: state.revision, handoffRevision: null }, 'Current findings and prices reviewed.');
  }
  if (action.type === 'handoff') return isReviewed(state) ? success({ ...state, handoffRevision: state.revision }, 'Simulated handoff only. No real Protractor ticket was created.') : fail('Review the current findings and pricing before simulating handoff.');
  let next = { ...state };
  if (action.type === 'wheel') next.wheels = state.wheels.map(w => w.id === action.id ? { ...w, ...(action.patch.unit && action.patch.unit !== w.unit ? { inner: '', center: '', outer: '' } : {}), ...action.patch, id: w.id } : w);
  if (action.type === 'battery') next.battery = { ...state.battery, ...action.patch };
  if (action.type === 'check') next.checks = state.checks.map(c => c.id === action.id ? { ...c, ...action.patch, id: c.id, mandatory: c.mandatory } : c);
  if (action.type === 'recommendation') next.recommendations = state.recommendations.map(r => r.id === action.id ? { ...r, ...action.patch, id: r.id } : r);
  if (action.type === 'toggle-check') {
    const existing = state.checks.find(c => c.id === action.id);
    if (existing?.mandatory) return fail('Required documentation cannot be removed.');
    const option = LIBRARY.find(c => c.id === action.id);
    if (!option) return fail('Unknown optional check.');
    next.checks = existing ? state.checks.filter(c => c.id !== action.id) : [...state.checks, { ...option, mandatory: false, rating: 'not-inspected', notes: '', thickness: '', media: [] }];
  }
  if (action.type === 'sample-green') {
    next.wheels = state.wheels.map(w => ({ ...w, inner: '7', center: '8', outer: '7', unit: '32nds', beforePsi: '34', afterPsi: '', rating: 'green', notes: 'Fictional sample: even wear; no visible damage observed.' }));
    next.battery = { ...state.battery, rated: '760', measured: '724', ratedStandard: 'CCA', measuredStandard: 'CCA', result: 'pass', voltage: '12.6', terminals: 'Clean and secure', notes: 'Fictional sample: technician-confirmed pass.' };
    next.checks = state.checks.map(c => c.mandatory ? { ...c, rating: 'green', notes: 'Fictional sample: no visible concern observed.' } : c);
  }
  return success({ ...next, revision: state.revision + 1, completedRevision: null, reviewedRevision: null, handoffRevision: null }, 'Edited. Completion and advisor review must be reconfirmed.');
}
