"use client";
import Link from "next/link";
import SheetManager from "@/components/shop-dispatch/SheetManager";
import styles from "@/components/shop-dispatch/pilot.module.css";

export default function DviSheetsSettingsPage() {
  return <main className={styles.root}>
    <header className={styles.header}><div><div className={styles.eyebrow}>Inspection settings</div><h1>DVI checklist library</h1><p>Approved sheets, without opening the workflow workspace.</p></div>
      <Link href="/dashboard/settings/inspection" className={styles.brandingLink}>Back to inspection settings</Link></header>
    <SheetManager />
  </main>;
}
