import { useAppearance } from '../../../AppearanceProvider';
import type { Appearance } from '../../../appearance';

export function AppearanceSelector() {
  const { preference, resolved, setPreference } = useAppearance();
  return <label className="appearance-control">Appearance
    <select aria-label="Appearance" aria-describedby="workflow-appearance-help" data-testid="workflow-appearance" value={preference} onChange={event => setPreference(event.target.value as Appearance)}>
      <option value="light">Light</option>
      <option value="dark">Dark</option>
      <option value="system">System</option>
    </select>
    <span id="workflow-appearance-help" className="appearance-help" aria-live="polite">{preference === 'system' ? `System · ${resolved === 'dark' ? 'Dark' : 'Light'}` : `${resolved === 'dark' ? 'Dark' : 'Light'} selected`}</span>
  </label>;
}
