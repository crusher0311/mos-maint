import JoinForm from "./JoinForm";

export const dynamic = "force-dynamic";

export default function JoinPage({ params }: { params: { code: string } }) {
  return <JoinForm code={params.code} />;
}
