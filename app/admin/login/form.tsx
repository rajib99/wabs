"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { loginAction } from "../actions";

export function LoginForm() {
  const [error, action, pending] = useActionState(loginAction, null);
  return (
    <form action={action} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm">ইমেইল<Input name="email" type="email" autoComplete="username" required /></label>
      <label className="flex flex-col gap-1 text-sm">পাসওয়ার্ড<Input name="password" type="password" autoComplete="current-password" required /></label>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <Button disabled={pending}>{pending ? "অপেক্ষা করুন..." : "প্রবেশ করুন"}</Button>
    </form>
  );
}
