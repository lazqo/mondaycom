"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { headers } from "next/headers";
import { authenticate, createSession, destroySession, homeFor } from "@/lib/auth";
import { checkLoginAllowed, clearLoginFailures, recordLoginFailure } from "@/lib/rate-limit";

const loginSchema = z.object({
  email: z.string().email("Enter a valid email"),
  password: z.string().min(1, "Enter your password"),
  next: z.string().optional(),
});

export type LoginState = { error?: string } | undefined;

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
    next: formData.get("next") ?? undefined,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "local";
  const key = `${ip}:${parsed.data.email.toLowerCase()}`;
  const gate = checkLoginAllowed(key);
  if (!gate.allowed) return { error: `Too many attempts. Try again in ${gate.retryAfterMinutes} min.` };
  const user = await authenticate(parsed.data.email, parsed.data.password);
  if (!user) {
    recordLoginFailure(key);
    return { error: "Incorrect email or password" };
  }
  clearLoginFailures(key);
  await createSession(user.id);
  const next = parsed.data.next && parsed.data.next.startsWith("/") && parsed.data.next !== "/" ? parsed.data.next : homeFor(user.role);
  redirect(next);
}

export async function logoutAction() {
  await destroySession();
  redirect("/login");
}
