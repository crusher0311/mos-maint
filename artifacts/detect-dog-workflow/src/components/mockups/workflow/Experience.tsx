import { useMemo, useState } from 'react';
import { Search, FileCheck2 } from 'lucide-react';
import summary from './_shared/burnett-summary.json';

type EvidenceEntry = { name: string; count: number };
export function topEvidence(entries: EvidenceEntry[], limit = 5): EvidenceEntry[] {
  return [...entries].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, limit);
}
export function evidenceDate(value: string): string {
  return new Date(value + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function Experience({ fictional = false }: { fictional?: boolean }) {
  const [search, setSearch] = useState('');
  const technicians = useMemo(() => {
    const query = search.toLocaleLowerCase().trim();
    return summary.technicians.filter(tech => [tech.name, ...tech.categories.map(c => c.name), ...tech.packages.map(p => p.name)].some(text => text.toLocaleLowerCase().includes(query)));
  }, [search]);
  return <section className="page" data-testid="experience-view">
    <div className="page-heading"><div><div className="eyebrow muted">Historical evidence / not a skill matrix</div><h1>Service history, in context.</h1><p className="muted">{summary.sourceLabel} · Jan 2–Oct 7, 2026</p></div><FileCheck2 className="icon"/></div>
    {fictional && <div className="source-banner"><strong>Separate historical dataset</strong>You are viewing the original fictional schedule. This page always shows Burnett’s historical evidence, not the fictional technicians’ experience.</div>}
    <div className="evidence-overview">
      <div className="settings-panel"><div className="eyebrow muted">Source coverage</div><h2 style={{marginTop:8}}>19 raw employee labels. No aliases merged.</h2>
        <dl className="coverage-list"><div><dt>Raw source rows</dt><dd>{summary.rawRows.toLocaleString()}</dd></div><div><dt>Distinct invoice numbers</dt><dd>{summary.invoiceNumbers.toLocaleString()}</dd></div><div><dt>Assigned source rows</dt><dd>{summary.assignedRows.toLocaleString()}</dd></div><div><dt>Duplicate / credit rows</dt><dd>{summary.duplicateRows} / {summary.creditRows}</dd></div></dl>
        <p className="muted">Location not onboarded. Current roster and independent skill are unverified. Labels reflect the source export, not verified technician identities.</p>
        <div className="alias-note"><strong>Confirm identity before combining.</strong>{summary.aliases.map(alias => <div key={alias.join('|')}>{alias.join(' / ')} — kept separate</div>)}</div>
      </div>
      <div className="settings-panel"><div className="eyebrow muted">Data quality / hours-field agreement</div><div className="evidence-stat">{summary.hoursMatchPercent.toFixed(2)}%</div>
        <p><strong>Not verified clock time.</strong> The exported hours fields agree in {summary.matchingHoursRows.toLocaleString()} of {summary.positiveHoursRows.toLocaleString()} positive-hours rows.</p>
        <p className="muted">This is a source-field consistency check, not evidence of technician efficiency, speed, skill ranking, or attendance. All schedule durations and timers elsewhere in this prototype are simulated.</p>
      </div>
    </div>
    <div className="prediction-note" style={{marginBottom:22}}>Category and package counts are deduplicated regular-invoice service-package entries—not repair counts or actual clock time. Categories are broad; diagnostics includes basic checks. Approved package names are a selected, privacy-reviewed shortlist, not an exhaustive history. Invoice counts are per label and must not be summed as unique shop invoices.</div>
    <div className="section-heading"><div><h2>Technician evidence</h2><p className="muted" aria-live="polite">{technicians.length} of {summary.technicians.length} source labels · alphabetical, not ranked</p></div><label className="search evidence-search"><span className="sr-only">Search technician, category, or approved package</span><Search className="icon"/><input aria-label="Search technician, category, or approved package" type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search names or observed services" data-testid="experience-search"/></label></div>
    <div className="evidence-grid">{technicians.map(tech => {
      const aliases = summary.aliases.find(group => group.includes(tech.name));
      return <article className="evidence-card" key={tech.name}><h3>{tech.name}</h3><div className="evidence-meta"><span>Most recent: {evidenceDate(tech.lastDate)}</span><span>{tech.invoiceCount.toLocaleString()} invoices</span></div>
        {aliases && <div className="alias-note">Possible alias: {aliases.filter(name => name !== tech.name).join(', ')}. Confirm identity before combining.</div>}
        <h4>Top observed categories / entries</h4><ul className="evidence-list">{topEvidence(tech.categories).map(category => <li key={category.name}><span>{category.name}</span><b>{category.count.toLocaleString()}</b></li>)}</ul>{!tech.categories.length && <p className="muted">No categorized evidence in this summary.</p>}
        <h4>Top approved packages / entries</h4><ul className="evidence-list">{topEvidence(tech.packages).map(pack => <li key={pack.name}><span>{pack.name}</span><b>{pack.count.toLocaleString()}</b></li>)}</ul>{!tech.packages.length && <p className="muted">No approved package names in the selected shortlist. This does not imply no work history.</p>}
      </article>;
    })}</div>
    {!technicians.length && <div className="empty"><Search className="icon"/><h3>No source labels match.</h3><p className="muted">Try a shorter name or a broad service category.</p><button className="btn" onClick={() => setSearch('')}>Clear search</button></div>}
  </section>;
}
