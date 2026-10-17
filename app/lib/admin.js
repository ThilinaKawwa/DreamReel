// Admin accounts: Supabase user ids listed in ADMIN_USER_IDS (server env, comma-separated).
export function isAdmin(userId) {
  return String(process.env.ADMIN_USER_IDS || '').split(',').map((s) => s.trim()).filter(Boolean).includes(userId);
}
