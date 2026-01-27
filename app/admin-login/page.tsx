export const dynamic = "force-dynamic";
export const revalidate = 0;

import PlatformAdminLoginForm from "./PlatformAdminLoginForm";
import Image from "next/image";

export default async function PlatformAdminLoginPage() {
  return (
    <div className="min-h-screen bg-gray-900 flex flex-col justify-center py-12 px-4 sm:px-6 lg:px-8">
      <div className="sm:mx-auto sm:w-full sm:max-w-md">
        <div className="flex justify-center">
          <Image 
            src="/mos-icon.png" 
            alt="MOS Tools" 
            width={48} 
            height={48} 
            className="rounded-xl"
          />
        </div>
        <h1 className="mt-6 text-center text-3xl font-bold text-white">
          Platform Admin
        </h1>
        <p className="mt-2 text-center text-sm text-gray-400">
          MOS Maintenance internal administration
        </p>
      </div>

      <div className="mt-8 sm:mx-auto sm:w-full sm:max-w-md">
        <div className="bg-gray-800 py-8 px-6 shadow-xl rounded-xl border border-gray-700">
          <PlatformAdminLoginForm />
        </div>
      </div>
    </div>
  );
}
