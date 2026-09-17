'use client';

import { usePathname } from 'next/navigation';

const Home = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-5v-6H10v6H5a1 1 0 0 1-1-1z"/></svg>
);
const Gallery = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="m3 16 5-5 4 4 3-3 6 6"/><circle cx="16" cy="9" r="1.5"/></svg>
);
const Plus = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M12 6v12M6 12h12"/></svg>
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
        <li><a href="/" className={is('/') ? 'on' : ''}><Home />Home</a></li>
        <li><a href="/gallery" className={is('/gallery') || is('/library') ? 'on' : ''}><Gallery />Gallery</a></li>
        <li><a href="/create" className={`create ${is('/create') ? 'on' : ''}`}><span className="ico"><Plus /></span>Create</a></li>
        <li><a href="/profile" className={is('/profile') ? 'on' : ''}><User />Profile</a></li>
      </ul>
    </nav>
  );
}
