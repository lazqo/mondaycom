// Runs once when the Next.js server starts. With INGEST_IN_PROCESS=true the IMAP watcher runs
// inside the web process, which keeps single-service hosting (one Railway/Render service) simple.
// The import stays inside the runtime check so the edge build never bundles Node-only modules.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    if (process.env.INGEST_IN_PROCESS === "true" || process.env.INGEST_IN_PROCESS === "1") {
      const { startIngestionLoop } = await import("./lib/email/service");
      startIngestionLoop((m) => console.log(`[ingest] ${m}`));
    }
  }
}
