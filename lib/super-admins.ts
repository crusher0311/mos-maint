import sql from "@/lib/db/postgres";

export const SUPER_ADMIN_EMAILS = [
  "brandoncrusha@gmail.com",
  "brandoncrusha+1@gmail.com"
];

export function isSuperAdmin(email: string | undefined | null): boolean {
  if (!email) return false;
  return SUPER_ADMIN_EMAILS.includes(email.toLowerCase());
}

export async function getPlatformAdminEmails(): Promise<string[]> {
  try {
    const rows = await sql`
      SELECT email FROM users
      WHERE is_platform_admin = true
    `;
    
    const emails = rows
      .map(row => (row.email as string)?.toLowerCase())
      .filter((email): email is string => Boolean(email));
    
    if (emails.length === 0) {
      console.warn("[super-admins] No platform admins found in database, using fallback list");
      return SUPER_ADMIN_EMAILS;
    }
    
    return emails;
  } catch (err) {
    console.error("[super-admins] Failed to fetch platform admins from database:", err);
    return SUPER_ADMIN_EMAILS;
  }
}

export async function isPlatformAdmin(email: string | undefined | null): Promise<boolean> {
  if (!email) return false;
  const admins = await getPlatformAdminEmails();
  return admins.includes(email.toLowerCase());
}
