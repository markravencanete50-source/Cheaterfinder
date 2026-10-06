import {describe,it,expect} from 'vitest';
import type Stripe from 'stripe';
import {currentInvoiceAttention} from '../billing-email-state.js';
const invoice=(status='requires_action')=>({id:'in_fixture',status:'open',customer:'cus_fixture',amount_remaining:3500,payments:{has_more:false,data:[{invoice:'in_fixture',is_default:true,status:'open',payment:{type:'payment_intent',payment_intent:{id:'pi_fixture',customer:'cus_fixture',status}}}]}} as unknown as Stripe.Invoice);
describe('current expanded invoice payment state',()=>{
 it('uses the live default intent, not the webhook event category',()=>{
  expect(currentInvoiceAttention(invoice())).toBe('action_required');expect(currentInvoiceAttention(invoice('requires_payment_method'))).toBe('payment_failed');
 });
 it.each(['processing','succeeded','requires_capture','requires_confirmation','canceled'])('suppresses an old failure once intent status is %s',status=>expect(currentInvoiceAttention(invoice(status))).toBeNull());
 it('requires a complete expanded owned default payment',()=>{
  for(const alter of [
   (i:Stripe.Invoice)=>{i.payments!.has_more=true;},
   (i:Stripe.Invoice)=>{i.payments!.data[0].is_default=false;},
   (i:Stripe.Invoice)=>{i.payments!.data[0].invoice='in_foreign';},
   (i:Stripe.Invoice)=>{i.payments!.data[0].payment.payment_intent='pi_not_expanded';},
   (i:Stripe.Invoice)=>{(i.payments!.data[0].payment.payment_intent as Stripe.PaymentIntent).customer='cus_foreign';},
   (i:Stripe.Invoice)=>{i.status='paid';},
   (i:Stripe.Invoice)=>{i.amount_remaining=0;},
  ]){const i=invoice();alter(i);expect(currentInvoiceAttention(i)).toBeNull();}
 });
});
