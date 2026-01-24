import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import LandingPagePromo from "../LandingPagePromo";

export const dynamic = 'force-dynamic';

export default async function PromoPage() {
  const session = await getSession();
  
  if (session) {
    redirect("/dashboard");
  }
  
  return <LandingPagePromo />;
}
