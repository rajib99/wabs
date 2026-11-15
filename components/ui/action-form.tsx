"use client";

import { useRouter } from "next/navigation";
import { createContext, useTransition, type FormEvent, type FormHTMLAttributes } from "react";
import type { ActionResult } from "@/lib/action-result";
import { toast } from "./toaster";

/** True while the enclosing ActionForm is submitting; Button reads it to disable itself. */
export const FormPending = createContext(false);

type Props = Omit<FormHTMLAttributes<HTMLFormElement>, "action" | "onSubmit"> & {
  action: (form: FormData) => Promise<ActionResult>;
  /** Clear the fields after a successful save (forms that create something). */
  resetOnSuccess?: boolean;
  /** Navigate here after a successful action (e.g. back to a list after deleting). */
  redirectTo?: string;
};

/**
 * A form for an admin server action that reports the outcome as a toast.
 * Submits via a transition instead of `<form action>` so React does not clear the fields when a save fails.
 */
export function ActionForm({ action, resetOnSuccess, redirectTo, children, ...props }: Props) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    const formEl = e.currentTarget;
    const data = new FormData(formEl, (e.nativeEvent as SubmitEvent).submitter);
    startTransition(async () => {
      try {
        const result = await action(data);
        if (result.ok) {
          toast("success", result.message);
          if (resetOnSuccess) formEl.reset();
          if (redirectTo) router.push(redirectTo);
        } else {
          toast("error", result.error);
        }
      } catch {
        toast("error", "সার্ভারে পৌঁছানো যায়নি। ইন্টারনেট দেখে আবার চেষ্টা করুন।");
      }
    });
  }
  return (
    <form {...props} onSubmit={onSubmit} aria-busy={pending}>
      <FormPending.Provider value={pending}>{children}</FormPending.Provider>
    </form>
  );
}
