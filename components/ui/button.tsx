import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

const button = cva("inline-flex min-h-10 items-center justify-center gap-2 rounded-md px-3 text-sm font-medium transition-opacity hover:opacity-90 disabled:opacity-50", {
  variants: {
    variant: {
      default: "bg-primary text-primary-foreground",
      outline: "border bg-card",
      destructive: "bg-destructive text-white dark:text-black",
    },
  },
  defaultVariants: { variant: "default" },
});

export function Button({ className, variant, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof button>) {
  return <button className={cn(button({ variant }), className)} {...props} />;
}
