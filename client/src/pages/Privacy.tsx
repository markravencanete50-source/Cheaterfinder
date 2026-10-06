import { Link } from "wouter";
import { ArrowLeft } from "lucide-react";

export default function Privacy() {
  return (
    <div className="min-h-screen bg-slate-50">
      <title>Privacy — CheaterFinder</title>
      <div className="max-w-3xl mx-auto px-4 py-12">
        <Link href="/">
          <button className="flex items-center gap-2 text-sm text-slate-500 hover:text-primary mb-8 transition-colors">
            <ArrowLeft className="w-4 h-4" />
            Back to Home
          </button>
        </Link>

        <h1 className="text-4xl font-bold text-slate-900 mb-2">Privacy Policy</h1>
        <p className="text-slate-500 mb-10">Last updated: September 11, 2026</p>

        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-8 md:p-10 space-y-8 text-slate-700 leading-relaxed">

          <section>
            <h2 className="text-xl font-bold text-slate-900 mb-3">1. Introduction</h2>
            <p>
              CheaterFinder ("we," "our," or "us") operates an Instagram activity tracking service available at cheaterfinder.com. This Privacy Policy explains how we collect, use, disclose, and safeguard your information when you use our service.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-slate-900 mb-3">2. Information We Collect</h2>
            <p className="mb-3">We collect the following types of information:</p>
            <ul className="list-disc pl-6 space-y-2">
              <li><strong>Account Information:</strong> Your name, email address, and hashed password when you create an account.</li>
              <li><strong>Payment Information:</strong> Payment details are collected and processed securely by Stripe. We do not store your full credit card number on our servers.</li>
              <li><strong>Tracked Instagram Data:</strong> The usernames you choose to track, profile details, observed activity and available media used in your reports. Private activity requires the account owner to accept a follow request from a service account; that request is visible to the owner. Access and complete results are not guaranteed.</li>
              <li><strong>Usage Data:</strong> Information about how you interact with our service, including pages visited, features used, and timestamps.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-bold text-slate-900 mb-3">3. How We Use Your Information</h2>
            <ul className="list-disc pl-6 space-y-2">
              <li>To provide and maintain our Instagram tracking service.</li>
              <li>To process your subscription payments.</li>
              <li>To send you service-related notifications and updates.</li>
              <li>To respond to your support requests.</li>
              <li>With your permission, to improve our service through limited, pseudonymous product analytics.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-bold text-slate-900 mb-3">4. Third-Party Services</h2>
            <p className="mb-3">We share information with the following third-party services as necessary to operate our platform:</p>
            <ul className="list-disc pl-6 space-y-2">
              <li><strong>Stripe:</strong> Processes subscription payments securely. Stripe's privacy policy applies to payment data they handle.</li>
              <li><strong>Resend:</strong> Sends transactional emails such as password resets and notifications. Your email address is shared with Resend for this purpose.</li>
              <li><strong>PostHog (US cloud):</strong> If you allow analytics, receives page categories and selected product actions, such as successful registration, starting checkout and requesting a report. Signed-in customer activity may be associated with an internal account identifier. We do not send names, email addresses, passwords, payment details, form contents, tracked Instagram usernames or collected Instagram data. URLs are reduced to page categories; query strings and reset/payment tokens are removed. Session recording, automatic click/form capture and admin-page analytics are disabled. Like other network services, PostHog receives connection information needed to receive requests. See <a href="https://posthog.com/privacy" className="text-primary underline" rel="noopener noreferrer" target="_blank">PostHog's privacy policy</a>.</li>
            </ul>
            <p className="mt-3">We do not sell, rent, or trade your personal information to any third parties for marketing purposes.</p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-slate-900 mb-3">5. Data Retention</h2>
            <p className="mb-3">
              Ending a subscription stops tracking and access to collected data once the paid period or Stripe trial ends. It does not delete your CheaterFinder account or all previously collected data. Retention depends on the type of data:
            </p>
            <ul className="list-disc pl-6 space-y-2">
              <li><strong>Detected likes and profile snapshots:</strong> Our daily cleanup removes records more than 90 days old, including while a subscription is active. Cleanup timing can vary if a run is delayed.</li>
              <li><strong>Saved reports and account-linked tracking records:</strong> Reports, follower/following history and other account-linked records remain until you delete your CheaterFinder account. Removing a profile from tracking stops new collection but does not erase its stored history. Saved reports may include summaries of observations that have since aged out of the 90-day window.</li>
              <li><strong>Operational records:</strong> Collection outcome logs and completed or failed collection-job records are normally cleaned up after 14 days. Pending and running jobs are excluded from that age-based cleanup.</li>
              <li><strong>Shared Instagram caches:</strong> Cached media and shared post details are stored separately from your account. Cancelling a subscription or deleting your account does not automatically remove these shared copies. Contact support@cheaterfinder.com about removal of specific cached content.</li>
            </ul>
            <p className="mt-3">
              A successfully completed account-deletion request removes your application account, login sessions and account-linked tracking records, including saved reports. Optional analytics is stored separately in PostHog; contact support@cheaterfinder.com to request access to or deletion of analytics associated with your account. Withdrawing consent stops new analytics collection; it does not automatically delete events already collected. Payment information held by Stripe is handled under Stripe's privacy policy.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-slate-900 mb-3">6. Your Rights</h2>
            <ul className="list-disc pl-6 space-y-2">
              <li><strong>Access:</strong> You can view your personal data through your account Settings page.</li>
              <li><strong>Deletion:</strong> You can request deletion of your application account and account-linked data from Settings at any time. See Data Retention above for shared caches and data held by third-party services.</li>
              <li><strong>Data Export:</strong> You may request a copy of your data by contacting us at support@cheaterfinder.com.</li>
              <li><strong>Correction:</strong> You can update your account information through the Settings page.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-bold text-slate-900 mb-3">7. Cookies and Analytics Preferences</h2>
            <p>
              Essential cookies support login and request security. Optional PostHog analytics stays off until you choose “Allow analytics.” After permission, PostHog uses browser local storage for a pseudonymous identifier; we configure it not to use analytics cookies. Your preference is also saved locally. You can reject analytics or change your choice using “Analytics preferences” without affecting your subscription or access to the service. We respect supported Do Not Track and Global Privacy Control signals. Development builds do not send analytics.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-slate-900 mb-3">8. Data Security</h2>
            <p>
              We implement industry-standard security measures including encrypted connections (HTTPS), hashed passwords, and secure session management. However, no method of transmission over the Internet is 100% secure, and we cannot guarantee absolute security.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-slate-900 mb-3">9. Children's Privacy</h2>
            <p>
              Our service is not intended for individuals under the age of 18. We do not knowingly collect personal information from children.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-slate-900 mb-3">10. Changes to This Policy</h2>
            <p>
              We may update this Privacy Policy from time to time. We will notify you of any material changes by posting the new policy on this page and updating the "Last updated" date. Your continued use of the service after changes are posted constitutes your acceptance of the updated policy.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-slate-900 mb-3">11. Contact Us</h2>
            <p>
              If you have any questions about this Privacy Policy or our data practices, please contact us at{" "}
              <a href="mailto:support@cheaterfinder.com" className="text-primary hover:underline font-medium">
                support@cheaterfinder.com
              </a>.
            </p>
          </section>

        </div>
      </div>
    </div>
  );
}
