export const dynamic = "force-dynamic";
export const revalidate = 0;

import ChangePasswordForm from "./ChangePasswordForm";

export default function ChangePasswordPage() {
  return (
    <div className="min-h-screen bg-gray-50 flex flex-col justify-center py-8 sm:py-12 px-4 sm:px-6 lg:px-8">
      <div className="sm:mx-auto sm:w-full sm:max-w-md">
        <div className="flex justify-center">
          <img
            src="/icon.png"
            alt="MOS.Tools"
            className="w-10 h-10 sm:w-12 sm:h-12 rounded-xl"
          />
        </div>
        <h1 className="mt-4 sm:mt-6 text-center text-2xl sm:text-3xl font-bold text-gray-900">
          Choose a new password
        </h1>
        <p className="mt-2 text-center text-sm text-gray-600">
          For your security, your password was reset by an administrator. Please
          set a new password that only you know.
        </p>
      </div>

      <div className="mt-6 sm:mt-8 sm:mx-auto sm:w-full sm:max-w-md">
        <div className="bg-white py-6 sm:py-8 px-4 sm:px-6 shadow-sm rounded-xl border border-gray-200">
          <ChangePasswordForm />
        </div>
      </div>
    </div>
  );
}
