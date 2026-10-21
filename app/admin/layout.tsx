import { AdminShell } from "@/components/admin/AdminShell";

// D-25: every staff page shares the navigation frame. Pages load their data client-side through /api/admin (D-16).
export default function AdminLayout({ children }: LayoutProps<"/admin">) {
  return <AdminShell>{children}</AdminShell>;
}
