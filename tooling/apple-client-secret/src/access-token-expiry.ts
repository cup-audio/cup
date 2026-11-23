const RENEWAL_WINDOW_DAYS = 30;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const RENEWAL_INSTRUCTIONS =
  "Renew it: create a new scoped Supabase access token, replace the production environment secret SUPABASE_ACCESS_TOKEN and update the repository variable SUPABASE_ACCESS_TOKEN_EXPIRES_ON (docs/production-configuration.md#renew-the-supabase-access-token).";

export function assertAccessTokenNotExpiringSoon(
  expiresOn: string | undefined,
  nowMilliseconds: number,
): void {
  const expiryDay = parseEpochDay(expiresOn);
  const today = Math.floor(nowMilliseconds / MILLISECONDS_PER_DAY);
  const daysLeft = expiryDay - today;

  if (daysLeft <= 0) {
    throw new Error(`The Supabase access token expired on ${expiresOn}. ${RENEWAL_INSTRUCTIONS}`);
  }
  if (daysLeft <= RENEWAL_WINDOW_DAYS) {
    throw new Error(
      `The Supabase access token expires on ${expiresOn}, in ${daysLeft} days. ${RENEWAL_INSTRUCTIONS}`,
    );
  }
}

function parseEpochDay(value: string | undefined): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? "");
  const year = Number(match?.[1]);
  const month = Number(match?.[2]);
  const day = Number(match?.[3]);
  if (!match || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new Error(
      `SUPABASE_ACCESS_TOKEN_EXPIRES_ON must hold the token's expiry date as YYYY-MM-DD, but holds "${value ?? ""}".`,
    );
  }
  return epochDayOfCivilDate(year, month, day);
}

function daysInMonth(year: number, month: number): number {
  const isLeapYear = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return [31, isLeapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
}

function epochDayOfCivilDate(year: number, month: number, day: number): number {
  const shiftedYear = month <= 2 ? year - 1 : year;
  const era = Math.floor(shiftedYear / 400);
  const yearOfEra = shiftedYear - era * 400;
  const dayOfYear = Math.floor((153 * (month > 2 ? month - 3 : month + 9) + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146_097 + dayOfEra - 719_468;
}
