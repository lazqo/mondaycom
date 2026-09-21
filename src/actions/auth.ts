"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { authenticate, createSession, destroySession } from "@/lib/auth";

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
  const user = await authenticate(parsed.data.email, parsed.data.password);
  if (!user) return { error: "Incorrect email or password" };
  await createSession(user.id);
  const next = parsed.data.next && parsed.data.next.startsWith("/") ? parsed.data.next : "/dashboard";
  redirect(next);
}

export async function logoutAction() {
  await destroySession();
  redirect("/login");
}
