'use client';

import { usePathname } from 'next/navigation';

const Guru = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/></svg>
);
const Dreams = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z"/><path d="M5 17a3 3 0 0 1 3-3h11M9 8h6"/></svg>
);
const Insights = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><circle cx="6" cy="7" r="1.6"/><circle cx="17" cy="5" r="1.6"/><circle cx="12" cy="13" r="1.6"/><circle cx="19" cy="17" r="1.6"/><circle cx="7" cy="19" r="1.6"/><path d="m7.3 8 3.6 3.8M13.4 12.2l2.6-5.6M13.3 14l4.4 2.4M10.8 14l-2.8 3.8"/></svg>
);
const User = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="10" r="3"/><path d="M6.5 18.5c1.5-2.5 3.5-3.5 5.5-3.5s4 1 5.5 3.5"/></svg>
);

export default function Nav() {
  const path = usePathname() || '/';
  const is = (p) => (p === '/' ? path === '/' : path.startsWith(p));
  return (
    <nav className="nav" aria-label="Main">
      <ul>
        <li><a href="/" className={is('/') ? 'on' : ''}><Guru />Guru</a></li>
        <li><a href="/dreams" className={is('/dreams') || is('/d/') || is('/gallery') || is('/library') ? 'on' : ''}><Dreams />Dreams</a></li>
        <li><a href="/insights" className={is('/insights') ? 'on' : ''}><Insights />Insights</a></li>
        <li><a href="/profile" className={is('/profile') ? 'on' : ''}><User />Profile</a></li>
      </ul>
    </nav>
  );
}
