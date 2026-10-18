export default function DviPushNotice({ message, needsVerification }: {
  message: string;
  needsVerification: boolean;
}) {
  return <div role="alert" className={`text-sm border rounded-lg px-3 py-2 ${
    needsVerification ? "text-amber-900 bg-amber-50 border-amber-300" : "text-red-700 bg-red-50 border-red-200"
  }`}>
    {needsVerification && <strong className="block">Verification needed</strong>}
    {message}
  </div>;
}
