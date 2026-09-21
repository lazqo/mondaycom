// In-process SMTP sink for tests: accepts any mail and keeps it in memory / writes to a dir.
import { mkdirSync, writeFileSync } from "node:fs";
import { SMTPServer } from "smtp-server";

export type SinkMessage = { from: string; to: string[]; raw: string };

export function startSmtpSink(port: number, outDir?: string): Promise<{ messages: SinkMessage[]; stop: () => Promise<void> }> {
  const messages: SinkMessage[] = [];
  if (outDir) mkdirSync(outDir, { recursive: true });
  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ["STARTTLS"],
    onAuth(_auth, _session, cb) {
      cb(null, { user: "test" });
    },
    onData(stream, session, cb) {
      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        const msg = { from: session.envelope.mailFrom ? session.envelope.mailFrom.address : "", to: session.envelope.rcptTo.map((r) => r.address), raw };
        messages.push(msg);
        if (outDir) writeFileSync(`${outDir}/${Date.now()}-${messages.length}.eml`, raw);
        cb();
      });
    },
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => resolve({ messages, stop: () => new Promise((r) => server.close(() => r())) }));
  });
}
