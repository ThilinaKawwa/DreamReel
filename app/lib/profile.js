// Small helpers for the person's name and greeting (kept on their phone).
export function getName() {
  try { return localStorage.getItem('dreamreel.name') || ''; } catch { return ''; }
}
export function setName(name) {
  try { localStorage.setItem('dreamreel.name', name); } catch {}
}
export function greeting(d = new Date()) {
  const h = d.getHours();
  if (h < 5) return 'Still up,';
  if (h < 12) return 'Good morning,';
  if (h < 18) return 'Good afternoon,';
  return 'Good evening,';
}
export function stamp(d = new Date()) {
  return `${d.toLocaleDateString('en-GB', { weekday: 'long' })} · ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
}
export function dreamDate(iso) {
  const d = new Date(iso), now = new Date();
  const days = Math.floor((now.setHours(0,0,0,0) - new Date(d).setHours(0,0,0,0)) / 86400000);
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (days === 0) return `Today · ${time}`;
  if (days === 1) return `Yesterday · ${time}`;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}
