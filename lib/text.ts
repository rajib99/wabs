const BN_DIGITS = "০১২৩৪৫৬৭৮৯";

/** Converts Bengali digits to ASCII. */
export function toAsciiDigits(input: string): string {
  return input.replace(/[০-৯]/g, (d) => String(BN_DIGITS.indexOf(d)));
}

export function toBengaliDigits(input: string | number): string {
  return String(input).replace(/[0-9]/g, (d) => BN_DIGITS[Number(d)]!);
}

const PHONE_RE = /(?:\+?\s*(?:88|৮৮)[\s-]*)?[0০][1১][\s-]*(?:[0-9০-৯][\s-]*){9}|\+\s*(?:[0-9০-৯][\s-]*){10,14}/g;
const CONTACT_RE = /(?:https?:\/\/|www\.)\S+|[\w.+-]+@[\w-]+\.[\w.-]+/gi;

/** Finds digit sequences that look like phone numbers, in ASCII or Bengali digits. */
export function findPhoneLike(text: string): string[] {
  return text.match(PHONE_RE) ?? [];
}

export function normalizeDigits(input: string): string {
  return toAsciiDigits(input).replace(/\D/g, "");
}

/** Removes phone numbers, links and emails from user-supplied free text before it is shown to anyone else. */
export function redactContactInfo(text: string): string {
  return text.replace(PHONE_RE, "[গোপন]").replace(CONTACT_RE, "[গোপন]");
}

/** Normalizes a Bangladeshi wallet number to 01XXXXXXXXX, or null when invalid. */
export function normalizeWalletNumber(input: string): string | null {
  let digits = normalizeDigits(input);
  if (digits.startsWith("880")) digits = digits.slice(2);
  return /^01[3-9]\d{8}$/.test(digits) ? digits : null;
}

export function render(template: string, vars: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => (key in vars ? String(vars[key]) : whole));
}
