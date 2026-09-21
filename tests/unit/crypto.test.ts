import { describe, it, expect } from "vitest";

process.env.DATABASE_URL ??= "postgres://x:y@localhost:5432/z";
process.env.AUTH_SECRET ??= "unit-test-secret-0123456789";

const { encryptSecret, decryptSecret } = await import("@/lib/crypto");

describe("secret encryption", () => {
  it("round-trips and never stores plaintext", () => {
    const enc = encryptSecret("app-password-123");
    expect(enc.startsWith("v1:")).toBe(true);
    expect(enc).not.toContain("app-password-123");
    expect(decryptSecret(enc)).toBe("app-password-123");
    expect(encryptSecret("same")).not.toBe(encryptSecret("same")); // random IV
  });
  it("rejects tampered payloads", () => {
    const enc = encryptSecret("x");
    const parts = enc.split(":");
    parts[3] = parts[3].slice(0, -2) + "AA";
    expect(() => decryptSecret(parts.join(":"))).toThrow();
  });
});
