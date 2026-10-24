import JoinForm from "./JoinForm";

export const dynamic = "force-dynamic";

export default async function JoinPage({ params }: { params: Promise<{ code: string }> }) {
  return <JoinForm code={(await params).code} />;
}
