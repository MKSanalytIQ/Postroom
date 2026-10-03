"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { logoutAction } from "@/lib/actions/auth";
import { Mark } from "./mark";

const LINKS = [
  ["/app", "Overview"],
  ["/app/lists", "Lists"],
  ["/app/contacts", "Contacts"],
  ["/app/suppressions", "Suppressions"],
  ["/app/templates", "Templates"],
  ["/app/campaigns", "Campaigns"],
  ["/app/automations", "Automations"],
  ["/app/settings", "Settings"],
];

export function Shell({ email, children }: { email: string; children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <>
      <div className="airmail" />
      <div className="app-body">
        <aside className="app-side">
          <Link href="/app" className="brand">
            <Mark /> Postroom
          </Link>
          <nav className="side-nav">
            {LINKS.map(([href, label]) => {
              const active = href === "/app" ? pathname === "/app" : pathname.startsWith(href);
              return (
                <Link key={href} href={href} className={active ? "active" : ""}>
                  {label}
                </Link>
              );
            })}
          </nav>
          <div className="side-foot">
            <span>{email}</span>
            <form action={logoutAction}>
              <button className="btn btn-ghost" type="submit">
                Sign out
              </button>
            </form>
          </div>
        </aside>
        <div className="app-main">
          <div className="app-main-inner">{children}</div>
        </div>
      </div>
    </>
  );
}
