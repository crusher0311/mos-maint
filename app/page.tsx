import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import LandingPage from "./LandingPage";

export default async function Home() {
  const session = await getSession();
  
  if (session) {
    redirect("/dashboard");
  }
  
  return <LandingPage />;
}
