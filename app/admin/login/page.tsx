import { redirect } from "next/navigation";

// There is no staff sign-in any more (D-22); old links to the sign-in page open the bookings page.
export default function LoginPage() {
  redirect("/admin");
}
