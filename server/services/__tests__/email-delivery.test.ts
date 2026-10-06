import { beforeEach, describe, expect, it, vi } from "vitest";
const send=vi.hoisted(()=>vi.fn());
vi.mock("resend",()=>({Resend:class {emails={send};}}));
import { EmailDeliveryError, sendApplicationEmail } from "../email-delivery.js";
describe("email provider acceptance",()=>{
  const message={to:"fixture@example.invalid",subject:"Fixture",html:"<p>Fixture</p>"};
  beforeEach(()=>{vi.stubEnv("RESEND_API_KEY","re_fixture_not_real");send.mockReset();});
  it("accepts only a provider message id and forwards the stable retry key",async()=>{
    send.mockResolvedValue({data:{id:"fixture-mail"},error:null});
    expect(await sendApplicationEmail(message,"job:fixture")).toBe("fixture-mail");
    expect(send.mock.calls[0][1]).toEqual({idempotencyKey:"job:fixture"});
  });
  it("turns a resolved SDK error into a queue failure, not a successful email",async()=>{
    send.mockResolvedValue({data:null,error:{name:"validation_error",message:"private provider details"}});
    await expect(sendApplicationEmail(message)).rejects.toMatchObject({name:"EmailDeliveryError",code:"validation_error"});
  });
  it("rejects missing configuration without claiming a mock email was sent",async()=>{
    vi.stubEnv("RESEND_API_KEY","");await expect(sendApplicationEmail(message)).rejects.toBeInstanceOf(EmailDeliveryError);
    expect(send).not.toHaveBeenCalled();
  });
  it("does not treat an empty success payload as acceptance",async()=>{
    send.mockResolvedValue({data:null,error:null});await expect(sendApplicationEmail(message)).rejects.toThrow();
  });
  it("bounds an ambiguous provider timeout without reporting success",async()=>{
    vi.useFakeTimers();
    try {
      send.mockReturnValue(new Promise(()=>{}));
      const result=expect(sendApplicationEmail(message,"timeout-fixture")).rejects.toMatchObject({code:"acceptance_timeout"});
      await vi.advanceTimersByTimeAsync(20_001);await result;
    } finally { vi.useRealTimers(); }
  });
});
