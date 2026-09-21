import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { extractedLeadSchema, trimBody, type ClassificationInput, type ClassificationResult, type LeadClassifier } from "./types";

const SYSTEM_PROMPT = `You classify and extract information from emails received by Get Secure, a New Zealand security installation company (CCTV, Ajax and other intruder alarms, alarm monitoring, access control, intercoms, gate automation, servicing and maintenance of those systems).

Decide whether the email is a genuine sales or service enquiry that Get Secure could quote for or attend. Enquiries from new and existing customers both count as leads. Supplier marketing, invoices, newsletters, recruitment, automated notifications, internal chatter, and spam are not leads.

Extract fields only from what the email says. Use null when a field is not present; never invent phone numbers, names, or addresses. Prefer the sender's signature block for name, company and phone. Phone numbers stay as written. Keep the summary to one or two plain sentences a technician could read at a glance. Set urgency from the customer's wording (a break-in, non-working alarm, or "ASAP" is urgent; "sometime next month" is low). The next_action is a short, concrete step for the Get Secure team.

confidence expresses how sure you are about is_lead and the extraction together. Be honest: forwarded chains, vague one-liners, and emails where the request is unclear should get a lower confidence so a person reviews them.`;

export class AnthropicClassifier implements LeadClassifier {
  readonly name = "anthropic";
  private client: Anthropic;
  constructor(
    private model: string,
    apiKey?: string,
  ) {
    this.client = new Anthropic(apiKey ? { apiKey } : {});
  }

  async classify(input: ClassificationInput): Promise<ClassificationResult> {
    const started = Date.now();
    const prior = (input.priorMessages ?? [])
      .map((m) => `--- earlier message from ${m.from} on ${m.date} ---\n${trimBody(m.text, 1500)}`)
      .join("\n\n");
    const attachments = input.attachments.length
      ? `Attachments: ${input.attachments.map((a) => `${a.filename} (${a.contentType}, ${a.size} bytes)`).join(", ")}`
      : "Attachments: none";
    const known = input.knownContact
      ? `The sender matches an existing CRM customer: ${input.knownContact.name}${input.knownContact.company ? ` (${input.knownContact.company})` : ""}.`
      : "The sender is not a known CRM customer.";

    const userContent = [
      `From: ${input.from.name ? `${input.from.name} <${input.from.address}>` : input.from.address}`,
      `To: ${input.to.join(", ")}`,
      `Date: ${input.receivedAt}`,
      `Subject: ${input.subject}`,
      attachments,
      known,
      "",
      "Email body:",
      trimBody(input.text),
      prior ? `\n\nThread context (oldest first):\n${prior}` : "",
    ].join("\n");

    const response = await this.client.messages.parse({
      model: this.model,
      max_tokens: 2048,
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: userContent }],
      output_config: { format: zodOutputFormat(extractedLeadSchema), effort: "low" },
    });

    if (response.stop_reason === "refusal") {
      throw new Error(`Model declined to classify this email (${response.stop_details?.category ?? "unspecified"})`);
    }
    const parsed = response.parsed_output;
    if (!parsed) throw new Error("Model returned no structured output");
    return {
      provider: this.name,
      model: response.model,
      result: parsed,
      raw: { stop_reason: response.stop_reason, usage: response.usage },
      usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
      durationMs: Date.now() - started,
    };
  }
}
