export const SUPER_ADMIN_EMAILS = [
  "brandoncrusha@gmail.com",
  "brandoncrusha+1@gmail.com"
];

export function isSuperAdmin(email: string | undefined | null): boolean {
  if (!email) return false;
  return SUPER_ADMIN_EMAILS.includes(email.toLowerCase());
}
