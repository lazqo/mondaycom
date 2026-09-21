import { describe, it, expect, vi } from "vitest";
import { AnthropicClassifier } from "@/lib/ai/anthropic-classifier";
import type { ClassificationInput } from "@/lib/ai/types";

const input: ClassificationInput = {
  from: { name: "Dean Walker", address: "dean@example.com" },
  to: ["info@getsecure.co.nz"],
  subject: "Ajax alarm for new build",
  receivedAt: "2026-09-21T00:00:00.000Z",
  text: "We want an Ajax alarm at 27 Kauri Grove. 027 555 0311",
  attachments: [],
};

function stub(response: Record<string, unknown>) {
  const c = new AnthropicClassifier("claude-opus-5", "sk-test");
  const parse = vi.fn().mockResolvedValue(response);
  // Replace the SDK client with a stub; only messages.parse is used.
  (c as unknown as { client: unknown }).client = { messages: { parse } };
  return { c, parse };
}

describe("AnthropicClassifier", () => {
  it("sends the email as a structured-output request and maps the parsed result", async () => {
    const parsed = {
      is_lead: true, confidence: 0.93, contact_name: "Dean Walker", company: null, email: "dean@example.com", phone: "027 555 0311",
      service: "Ajax alarm", site_address: "27 Kauri Grove", summary: "Ajax alarm for a new build.", urgency: "normal", next_action: "Call to book a site visit.", reason: "Clear enquiry.",
    };
    const { c, parse } = stub({ parsed_output: parsed, stop_reason: "end_turn", model: "claude-opus-5", usage: { input_tokens: 900, output_tokens: 120 } });
    const r = await c.classify(input);
    expect(r.provider).toBe("anthropic");
    expect(r.model).toBe("claude-opus-5");
    expect(r.result).toEqual(parsed);
    expect(r.usage).toEqual({ inputTokens: 900, outputTokens: 120 });
    const call = parse.mock.calls[0][0];
    expect(call.model).toBe("claude-opus-5");
    expect(call.output_config.format).toBeTruthy();
    expect(call.output_config.effort).toBe("low");
    expect(call.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(call.messages[0].content).toContain("Subject: Ajax alarm for new build");
    expect(call.messages[0].content).toContain("027 555 0311");
  });

  it("throws on a refusal so the pipeline marks the email as error rather than guessing", async () => {
    const { c } = stub({ parsed_output: null, stop_reason: "refusal", stop_details: { type: "refusal", category: "other" }, model: "claude-opus-5", usage: {} });
    await expect(c.classify(input)).rejects.toThrow(/declined/);
  });

  it("throws when no structured output came back", async () => {
    const { c } = stub({ parsed_output: null, stop_reason: "end_turn", model: "claude-opus-5", usage: {} });
    await expect(c.classify(input)).rejects.toThrow(/no structured output/);
  });
});
