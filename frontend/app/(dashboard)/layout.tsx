import Link from "next/link";

const nav = [
  { href: "/programs", label: "Programs" },
  { href: "/worklist", label: "Worklist" },
  { href: "/measures", label: "Measures" },
  { href: "/studio", label: "Studio" },
  { href: "/runs", label: "Test Runs" },
  { href: "/admin", label: "Admin" }
];

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-screen grid-cols-[240px_1fr]">
      <aside className="border-r border-slate-200 bg-white p-5">
        <h1 className="text-lg font-semibold">WorkWell Studio</h1>
        <p className="mt-1 text-xs text-slate-500">MVP Dashboard Shell</p>
        <nav className="mt-6 space-y-2">
          {nav.map((item) => (
            <Link key={item.href} href={item.href} className="block rounded-md px-3 py-2 text-sm text-slate-700 hover:bg-slate-100">
              {item.label}
            </Link>
          ))}
        </nav>
      </aside>
      <main className="p-8">{children}</main>
    </div>
  );
}
