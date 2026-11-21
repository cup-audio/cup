/**
 * Whether a sign-in identity's email is on the account allowlist: the `ACCOUNT_ALLOWLIST` secret's
 * comma-separated addresses, compared case-insensitively and exactly. An identity without an email,
 * and every identity while the list is empty, is not on it.
 */
export function isOnAccountAllowlist(email: string | undefined, accountAllowlist: string) {
  if (email === undefined) {
    return false;
  }

  const normalizedEmail = email.trim().toLowerCase();
  return accountAllowlist
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .some((entry) => entry !== "" && entry === normalizedEmail);
}
