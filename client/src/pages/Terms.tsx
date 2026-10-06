import { Link } from "wouter";
import { ArrowLeft } from "lucide-react";

export default function Terms() {
  return (
    <div className="min-h-screen bg-slate-50">
      <title>Terms — CheaterFinder</title>
      <div className="max-w-3xl mx-auto px-4 py-12">
        <Link href="/">
          <button className="flex items-center gap-2 text-sm text-slate-500 hover:text-primary mb-8 transition-colors">
            <ArrowLeft className="w-4 h-4" />
            Back to Home
          </button>
        </Link>

        <h1 className="text-4xl font-bold text-slate-900 mb-2">Terms of Service</h1>
        <p className="text-slate-500 mb-10">Last updated: September 24, 2026</p>

        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-8 md:p-10 space-y-8 text-slate-700 leading-relaxed">

          <section>
            <h2 className="text-xl font-bold text-slate-900 mb-3">1. Service Description</h2>
            <p>
              CheaterFinder provides reports on observed Instagram activity for accounts you choose to track, including detected post and Reel likes and changes in followers and following. Collection is periodic and depends on available data and Instagram access. Reports may be delayed or incomplete and do not contain every interaction or a complete historical record.
            </p>
            <p className="mt-3">
              Publicly visible information can be collected without your Instagram password. Private activity requires the account owner to accept a follow request from a service account. That request is visible to the owner. Acceptance, continued access and timing are not guaranteed, and we do not guarantee anonymous tracking. A subscription does not bypass private-account approval.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-slate-900 mb-3">2. Acceptable Use</h2>
            <p className="mb-3">By using CheaterFinder, you agree to the following:</p>
            <ul className="list-disc pl-6 space-y-2">
              <li><strong>Personal use only:</strong> The service is intended for personal, non-commercial use. You may not use it for commercial data resale, competitive intelligence gathering, or any business purpose without our written consent.</li>
              <li><strong>No harassment or stalking:</strong> You may not use this service to harass, stalk, intimidate, or harm any individual. Any use that violates another person's rights or safety is strictly prohibited.</li>
              <li><strong>No automated access:</strong> You may not use bots, scrapers, or automated tools to access our service outside of the provided user interface.</li>
              <li><strong>Compliance with laws:</strong> You must comply with all applicable local, state, national, and international laws when using our service.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-bold text-slate-900 mb-3">3. Account Terms</h2>
            <ul className="list-disc pl-6 space-y-2">
              <li>You must provide accurate and complete information when creating an account.</li>
              <li>You are limited to one account per person.</li>
              <li>You are responsible for maintaining the security of your account credentials.</li>
              <li>You must be at least 18 years of age to use this service.</li>
              <li>You are responsible for all activity that occurs under your account.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-bold text-slate-900 mb-3">4. Payment Terms</h2>
            <ul className="list-disc pl-6 space-y-2">
              <li>All payments are processed securely through Stripe.</li>
              <li>Tracking and access to collected data require an active paid Stripe subscription or an active Stripe trial. Creating an account alone does not grant free tracking or data access.</li>
              <li>Eligible customers may start a 3-day trial through Stripe checkout with a payment method. Eligibility and the amount due are confirmed at checkout. Cancel before the trial ends to avoid the subscription charge.</li>
              <li>Some new trial offers require a US$0.99 advance payment, disclosed before you confirm checkout. Where this offer applies, the trial starts after payment confirmation and the same amount is added once as credit toward your next invoice. This is a payment, not a temporary authorization hold. It does not guarantee future payment approval or private-profile access.</li>
              <li>Invoice credit reduces the amount due on the next applicable invoice. A plan change or another invoice can use that credit before the first monthly renewal. First monthly estimates assume no such changes and exclude applicable taxes unless checkout states otherwise. Existing trials and subscriptions keep the payment terms already accepted.</li>
              <li>The cancellation policy shown and accepted at checkout governs the advance payment. If the offer provides a refund when you cancel before the trial expires, cancellation ends trial access immediately and refunds the unused advance. That refunded amount cannot also remain as invoice credit. If the offer states that the advance remains as credit, cancellation does not automatically refund it. Your billing settings show the payment, credit and refund status.</li>
              <li>If you have unused advance credit or an unresolved advance payment or refund, resolve it in billing or contact support before deleting your account. Account deletion may require that billing review so a remaining credit or refund is not lost.</li>
              <li>After the trial, your subscription will automatically renew monthly unless cancelled. Legacy billing intervals remain unchanged for existing subscribers.</li>
              <li>You may cancel your subscription at any time from the Settings page. Cancellation takes effect at the end of the current billing period, except when your trial's advance-payment refund terms provide for immediate cancellation and the end of access.</li>
              <li>We do not offer refunds for partial billing periods, except for any advance-payment refund expressly included in the checkout terms or as required by applicable law. Access continues until the end of the paid period unless the cancellation terms above provide otherwise.</li>
              <li>We reserve the right to change pricing with 30 days notice. Existing subscribers will be notified before any price change takes effect.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-bold text-slate-900 mb-3">5. Data and Privacy</h2>
            <p>
              Your use of CheaterFinder is also governed by our{" "}
              <Link href="/privacy">
                <span className="text-primary hover:underline font-medium cursor-pointer">Privacy Policy</span>
              </Link>
              , which describes how we collect, use, and protect your information.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-slate-900 mb-3">6. Limitations of Liability</h2>
            <ul className="list-disc pl-6 space-y-2">
              <li>CheaterFinder is provided "as is" without warranties of any kind, express or implied.</li>
              <li>We do not guarantee the accuracy, completeness, or timeliness of Instagram data collected by our service.</li>
              <li>We are not responsible for any changes to Instagram's platform that may affect our ability to collect data.</li>
              <li>In no event shall CheaterFinder be liable for any indirect, incidental, special, consequential, or punitive damages arising from your use of the service.</li>
              <li>Our total liability to you for any claims arising from your use of the service shall not exceed the amount you paid us in the 3 months preceding the claim.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-bold text-slate-900 mb-3">7. Termination</h2>
            <p>
              We reserve the right to suspend or terminate your account at any time if we determine that you have violated these Terms of Service. In cases of violation, termination may be immediate and without prior notice. You may also delete your account at any time from the Settings page.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-slate-900 mb-3">8. Changes to These Terms</h2>
            <p>
              We may update these Terms of Service from time to time. We will notify you of material changes by posting the updated terms on this page and updating the "Last updated" date. Your continued use of the service after changes are posted constitutes your acceptance of the revised terms.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-slate-900 mb-3">9. Governing Law</h2>
            <p>
              These Terms shall be governed by and construed in accordance with the laws of the United States, without regard to conflict of law principles.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-slate-900 mb-3">10. Contact Us</h2>
            <p>
              If you have any questions about these Terms of Service, please contact us at{" "}
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
