import "dotenv/config";
import Stripe from "stripe";

async function main(): Promise<void> {
  const s = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: "2026-03-25.dahlia" });
  const subs = await s.subscriptions.list({ status: "all", limit: 100 });
  const active = subs.data.filter((x) => ["active", "trialing", "past_due"].includes(x.status));
  console.log(`[subs] total=${subs.data.length} active/trialing/past_due=${active.length}`);
  for (const sub of active) {
    const price = sub.items.data[0]?.price;
    console.log(
      `[subs] ${sub.id} status=${sub.status} price=${price?.id} amount=$${((price?.unit_amount ?? 0) / 100).toFixed(2)} coupon=${sub.discount?.coupon?.name ?? "none"}`,
    );
  }
}

main().catch((e) => console.error("[subs] ERR", e instanceof Error ? e.message : String(e)));
