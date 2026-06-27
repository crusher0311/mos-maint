import { requirePlatformAdmin } from "@/lib/auth";
import CarfaxMatchClient from "./CarfaxMatchClient";

export const dynamic = "force-dynamic";

export default async function CarfaxMatchPage() {
  await requirePlatformAdmin();
  return <CarfaxMatchClient />;
}
