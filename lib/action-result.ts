import { unstable_rethrow } from "next/navigation";
import { ZodError } from "zod";

export type ActionResult = { ok: true; message: string } | { ok: false; error: string };

function describe(err: unknown): string {
  if (err instanceof ZodError) return err.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)).join("; ");
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Runs an admin action and turns the outcome into a message for the toast.
 * Redirects and auth bounces are rethrown so Next.js still handles them.
 */
export async function attempt(message: string, fn: () => Promise<unknown>): Promise<ActionResult> {
  try {
    await fn();
    return { ok: true, message };
  } catch (err) {
    unstable_rethrow(err);
    return { ok: false, error: `সংরক্ষণ হয়নি: ${describe(err)}` };
  }
}
