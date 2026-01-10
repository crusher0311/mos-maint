export const dynamic = "force-dynamic";
export const revalidate = 0;

import LoginForm from "./LoginForm";
import Link from "next/link";

export default async function LoginPage() {
  return (
    <div className="min-h-screen bg-gray-50 flex flex-col justify-center py-8 sm:py-12 px-4 sm:px-6 lg:px-8">
      <div className="sm:mx-auto sm:w-full sm:max-w-md">
        <div className="flex justify-center">
          <Link href="/" className="flex items-center gap-2">
            <img src="/icon.png" alt="MOS.Tools" className="w-10 h-10 sm:w-12 sm:h-12 rounded-xl" />
          </Link>
        </div>
        <h1 className="mt-4 sm:mt-6 text-center text-2xl sm:text-3xl font-bold text-gray-900">
          Welcome back
        </h1>
        <p className="mt-2 text-center text-sm text-gray-600">
          Sign in to your MOS.Tools account
        </p>
      </div>

      <div className="mt-6 sm:mt-8 sm:mx-auto sm:w-full sm:max-w-md">
        <div className="bg-white py-6 sm:py-8 px-4 sm:px-6 shadow-sm rounded-xl border border-gray-200">
          <LoginForm />
        </div>
      </div>
    </div>
  );
}
