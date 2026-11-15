"use client";

import { cva, type VariantProps } from "class-variance-authority";
import { useContext, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";
import { FormPending } from "./action-form";

const button = cva("inline-flex min-h-10 cursor-pointer items-center justify-center gap-2 rounded-md px-3 text-sm font-medium transition-opacity hover:opacity-90 active:opacity-75 disabled:cursor-progress disabled:opacity-50", {
  variants: {
    variant: {
      default: "bg-primary text-primary-foreground",
      outline: "border bg-card",
      destructive: "bg-destructive text-white dark:text-black",
    },
  },
  defaultVariants: { variant: "default" },
});

export function Button({ className, variant, disabled, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof button>) {
  const pending = useContext(FormPending);
  return <button className={cn(button({ variant }), className)} disabled={disabled || pending} aria-busy={pending || undefined} {...props} />;
}
