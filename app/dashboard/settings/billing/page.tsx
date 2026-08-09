import { redirect } from "next/navigation";

// The customer-facing billing page has been removed. Billing is managed
// internally (admin / platform-admin). Redirect any direct visits to the
// settings area.
export default function BillingSettingsPage() {
  redirect("/dashboard/settings/preferences");
}
