import assert from "node:assert/strict";
import { test } from "vitest";

import { assertAccessTokenNotExpiringSoon } from "#src/access-token-expiry.ts";

const OCTOBER_1_2027_AT_23_59_UTC = 1_822_435_140_000;
const OCTOBER_2_2027_AT_MIDNIGHT_UTC = 1_822_435_200_000;
const NOVEMBER_5_2027_AT_NOON_UTC = 1_825_416_000_000;
const JANUARY_1_2027_AT_MIDNIGHT_UTC = 1_798_761_600_000;
const FEBRUARY_29_2028_AT_MIDNIGHT_UTC = 1_835_395_200_000;

test("passes while the Supabase access token expires in more than 30 days", () => {
  assert.doesNotThrow(() =>
    assertAccessTokenNotExpiringSoon("2027-11-01", OCTOBER_1_2027_AT_23_59_UTC),
  );
});

test("fails with a renewal message from 30 days before the token expires", () => {
  assert.throws(
    () => assertAccessTokenNotExpiringSoon("2027-11-01", OCTOBER_2_2027_AT_MIDNIGHT_UTC),
    /expires on 2027-11-01, in 30 days\. Renew it/,
  );
});

test("fails once the token has expired", () => {
  assert.throws(
    () => assertAccessTokenNotExpiringSoon("2027-11-01", NOVEMBER_5_2027_AT_NOON_UTC),
    /expired on 2027-11-01\. Renew it/,
  );
});

test("counts leap days when the expiry date lies beyond February 29", () => {
  assert.throws(
    () => assertAccessTokenNotExpiringSoon("2028-03-30", FEBRUARY_29_2028_AT_MIDNIGHT_UTC),
    /in 30 days/,
  );
});

test("fails when the expiry date is missing or not a calendar date", () => {
  for (const expiresOn of [undefined, "", "1 Nov 2027", "2027-02-29", "2027-13-01"]) {
    assert.throws(
      () => assertAccessTokenNotExpiringSoon(expiresOn, JANUARY_1_2027_AT_MIDNIGHT_UTC),
      /SUPABASE_ACCESS_TOKEN_EXPIRES_ON must hold the token's expiry date as YYYY-MM-DD/,
    );
  }
});
