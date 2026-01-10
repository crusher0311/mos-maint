import { Wrench, ArrowLeft } from "lucide-react";
import Link from "next/link";

export const metadata = {
  title: "Privacy Policy | MOS Tools",
  description: "Privacy Policy for MOS Tools website and Chrome Extension",
};

export default function PrivacyPolicyPage() {
  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between py-6">
            <Link href="/" className="flex items-center gap-3">
              <div className="w-10 h-10 bg-blue-600 rounded-xl flex items-center justify-center">
                <Wrench className="w-6 h-6 text-white" />
              </div>
              <span className="text-xl font-bold text-gray-900">MOS Tools</span>
            </Link>
            <Link
              href="/"
              className="flex items-center gap-2 text-sm text-gray-600 hover:text-gray-900"
            >
              <ArrowLeft className="w-4 h-4" />
              Back to Home
            </Link>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-8 sm:p-12">
          <h1 className="text-3xl font-bold text-gray-900 mb-2">Privacy Policy</h1>
          <p className="text-gray-500 mb-8">Last updated: January 2026</p>

          <div className="prose prose-gray max-w-none">
            <section className="mb-8">
              <h2 className="text-xl font-semibold text-gray-900 mb-4">1. Introduction</h2>
              <p className="text-gray-700 leading-relaxed">
                MOS Tools (&quot;we,&quot; &quot;us,&quot; or &quot;our&quot;) operates the mos.tools website and the MOS Tools Chrome Extension (the &quot;Service&quot;).
              </p>
              <p className="text-gray-700 leading-relaxed mt-4">
                This Privacy Policy explains how we collect, use, disclose, and safeguard information when you use our website, software platform, and Chrome extension. By using the Service, you agree to the collection and use of information in accordance with this policy.
              </p>
            </section>

            <section className="mb-8">
              <h2 className="text-xl font-semibold text-gray-900 mb-4">2. Information We Collect</h2>
              
              <h3 className="text-lg font-medium text-gray-800 mt-6 mb-3">2.1 Information Collected by the Chrome Extension</h3>
              <p className="text-gray-700 leading-relaxed mb-4">
                The MOS Tools Chrome Extension collects contextual, non-personal data from the active Tekmetric page in order to function correctly, including:
              </p>
              <ul className="list-disc pl-6 text-gray-700 space-y-2 mb-4">
                <li>Vehicle Identification Numbers (VINs)</li>
                <li>Repair Order (RO) numbers</li>
                <li>Vehicle mileage and service history context</li>
                <li>Shop identifiers and configuration data</li>
                <li>Feature usage and visit-based usage counts (VIN + RO combinations)</li>
                <li>Authentication tokens required to securely access MOS Tools services</li>
              </ul>
              
              <p className="text-gray-700 leading-relaxed mb-4">The extension does not collect:</p>
              <ul className="list-disc pl-6 text-gray-700 space-y-2">
                <li>Names, email addresses, phone numbers, or contact details</li>
                <li>Payment or financial information</li>
                <li>Personal communications</li>
                <li>Precise physical location or GPS data</li>
              </ul>

              <h3 className="text-lg font-medium text-gray-800 mt-6 mb-3">2.2 Website and Platform Data</h3>
              <p className="text-gray-700 leading-relaxed mb-4">
                When using the MOS Tools website or platform, we may collect:
              </p>
              <ul className="list-disc pl-6 text-gray-700 space-y-2">
                <li>Account information (such as business name and login credentials)</li>
                <li>Subscription and plan entitlement status</li>
                <li>Usage analytics related to feature access and limits</li>
                <li>Support communications submitted by users</li>
              </ul>
            </section>

            <section className="mb-8">
              <h2 className="text-xl font-semibold text-gray-900 mb-4">3. How We Use Information</h2>
              <p className="text-gray-700 leading-relaxed mb-4">
                We use collected information strictly for core product functionality, including:
              </p>
              <ul className="list-disc pl-6 text-gray-700 space-y-2 mb-4">
                <li>Displaying maintenance plans and recommendations</li>
                <li>Enabling job history lookup and enterprise search</li>
                <li>Managing subscriptions, feature access, and trial limits</li>
                <li>Providing secure authentication and authorization</li>
                <li>Improving reliability, security, and performance</li>
                <li>Providing customer support upon request</li>
              </ul>
              <p className="text-gray-700 leading-relaxed">
                We do not use collected data for advertising, profiling, or marketing purposes.
              </p>
            </section>

            <section className="mb-8">
              <h2 className="text-xl font-semibold text-gray-900 mb-4">4. Data Sharing and Disclosure</h2>
              <p className="text-gray-700 leading-relaxed mb-4">
                We do not sell, rent, or trade user data to third parties.
              </p>
              <p className="text-gray-700 leading-relaxed mb-4">Data may be shared only with:</p>
              <ul className="list-disc pl-6 text-gray-700 space-y-2 mb-4">
                <li>Trusted service providers required to operate the platform (e.g., hosting, database, payment processors)</li>
                <li>Legal or regulatory authorities when required by law</li>
              </ul>
              <p className="text-gray-700 leading-relaxed">
                All service providers are contractually obligated to protect data and use it only for authorized purposes.
              </p>
            </section>

            <section className="mb-8">
              <h2 className="text-xl font-semibold text-gray-900 mb-4">5. Data Security</h2>
              <p className="text-gray-700 leading-relaxed mb-4">
                We implement industry-standard security measures to protect data, including:
              </p>
              <ul className="list-disc pl-6 text-gray-700 space-y-2 mb-4">
                <li>Encrypted data transmission over HTTPS</li>
                <li>Secure storage of authentication credentials</li>
                <li>Role-based access controls</li>
                <li>Limited data retention aligned with operational needs</li>
              </ul>
              <p className="text-gray-700 leading-relaxed">
                Despite our efforts, no method of transmission or storage is 100% secure, and we cannot guarantee absolute security.
              </p>
            </section>

            <section className="mb-8">
              <h2 className="text-xl font-semibold text-gray-900 mb-4">6. Data Retention</h2>
              <p className="text-gray-700 leading-relaxed mb-4">
                We retain collected data only as long as necessary to:
              </p>
              <ul className="list-disc pl-6 text-gray-700 space-y-2 mb-4">
                <li>Provide the Service</li>
                <li>Meet legal, accounting, or operational requirements</li>
                <li>Enforce subscription limits and platform integrity</li>
              </ul>
              <p className="text-gray-700 leading-relaxed">
                Data may be anonymized or deleted upon account termination unless retention is required by law.
              </p>
            </section>

            <section className="mb-8">
              <h2 className="text-xl font-semibold text-gray-900 mb-4">7. User Rights and Data Deletion</h2>
              <p className="text-gray-700 leading-relaxed mb-4">Users may request:</p>
              <ul className="list-disc pl-6 text-gray-700 space-y-2 mb-4">
                <li>Access to their data</li>
                <li>Correction of inaccurate data</li>
                <li>Deletion of their data</li>
              </ul>
              <p className="text-gray-700 leading-relaxed">
                Requests can be submitted by contacting us at:{" "}
                <a href="mailto:support@mos.tools" className="text-blue-600 hover:underline">
                  support@mos.tools
                </a>
              </p>
            </section>

            <section className="mb-8">
              <h2 className="text-xl font-semibold text-gray-900 mb-4">8. Third-Party Services</h2>
              <p className="text-gray-700 leading-relaxed">
                MOS Tools integrates with third-party automotive systems (such as Tekmetric) solely to provide contextual functionality. We do not control the privacy practices of third-party platforms, and users should review their respective privacy policies.
              </p>
            </section>

            <section className="mb-8">
              <h2 className="text-xl font-semibold text-gray-900 mb-4">9. Children&apos;s Privacy</h2>
              <p className="text-gray-700 leading-relaxed">
                MOS Tools is a business-to-business service and is not intended for use by children under the age of 13. We do not knowingly collect personal information from children.
              </p>
            </section>

            <section className="mb-8">
              <h2 className="text-xl font-semibold text-gray-900 mb-4">10. Changes to This Privacy Policy</h2>
              <p className="text-gray-700 leading-relaxed">
                We may update this Privacy Policy from time to time. Changes will be posted on this page with an updated &quot;Last updated&quot; date. Continued use of the Service after changes constitutes acceptance of the updated policy.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-gray-900 mb-4">11. Contact Us</h2>
              <p className="text-gray-700 leading-relaxed mb-4">
                If you have questions about this Privacy Policy or our data practices, contact us at:
              </p>
              <div className="bg-gray-50 rounded-lg p-6 border border-gray-200">
                <p className="font-semibold text-gray-900">MOS Tools</p>
                <p className="text-gray-700 mt-2">
                  Website:{" "}
                  <a href="https://mos.tools" className="text-blue-600 hover:underline">
                    https://mos.tools
                  </a>
                </p>
                <p className="text-gray-700">
                  Email:{" "}
                  <a href="mailto:support@mos.tools" className="text-blue-600 hover:underline">
                    support@mos.tools
                  </a>
                </p>
              </div>
            </section>
          </div>
        </div>
      </main>

      <footer className="border-t border-gray-200 bg-white mt-12">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <p className="text-center text-sm text-gray-500">
            &copy; {new Date().getFullYear()} MOS Tools. All rights reserved.
          </p>
        </div>
      </footer>
    </div>
  );
}
