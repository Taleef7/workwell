"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { FormEvent, useState } from "react";

const nav = [
  { href: "/programs", label: "Programs" },
  { href: "/worklist", label: "Worklist" },
  { href: "/measures", label: "Measures" },
  { href: "/studio", label: "Studio" },
  { href: "/runs", label: "Test Runs" },
  { href: "/admin", label: "Admin" }
];

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const [search, setSearch] = useState("");

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const term = search.trim();
    if (!term) return;
    router.push(`/cases?search=${encodeURIComponent(term)}`);
    setMenuOpen(false);
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 px-4 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-[1600px] items-center gap-3">
          <button
            type="button"
            className="rounded border border-slate-300 px-2 py-1 text-sm md:hidden"
            onClick={() => setMenuOpen((v) => !v)}
            aria-label="Toggle navigation"
          >
            ☰
          </button>
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold">WorkWell Studio</h1>
            <p className="text-xs text-slate-500">MVP Dashboard Shell</p>
          </div>
          <form className="ml-auto w-full max-w-md" onSubmit={submitSearch}>
            <input
              className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
              placeholder="Global search by employee name or ID"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </form>
        </div>
      </header>

      <div className="mx-auto grid max-w-[1600px] md:grid-cols-[220px_1fr]">
        <aside className={`${menuOpen ? "block" : "hidden"} border-r border-slate-200 bg-white p-4 md:block`}>
          <nav className="space-y-2">
            {nav.map((item) => {
              const active = pathname?.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setMenuOpen(false)}
                  className={`block rounded-md px-3 py-2 text-sm ${active ? "bg-slate-900 text-white" : "text-slate-700 hover:bg-slate-100"}`}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </aside>
        <main className="min-w-0 p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}
