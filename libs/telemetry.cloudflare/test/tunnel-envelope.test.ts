import { expect, test } from "vitest";

import { rewriteTunnelEnvelope } from "#src/tunnel-envelope.ts";

const ENVELOPE_HEADER =
  '{"dsn":"https://public@o1.ingest.de.sentry.io/2","sent_at":"2026-11-16T12:00:00.000Z"}';

type ParsedItem = { header: object; payload: string };

/**
 * Reads an envelope the way Sentry's ingestion does: a payload is exactly `length` bytes when its
 * item header declares a length, and runs to the next newline otherwise.
 */
function parseEnvelope(envelope: Uint8Array): { header: string; items: ParsedItem[] } {
  const decoder = new TextDecoder();
  let position = envelope.indexOf(10);
  const header = decoder.decode(envelope.subarray(0, position));
  position += 1;

  const items: ParsedItem[] = [];
  while (position < envelope.length) {
    const headerEnd = envelope.indexOf(10, position);
    const itemHeader: unknown = JSON.parse(decoder.decode(envelope.subarray(position, headerEnd)));
    if (typeof itemHeader !== "object" || itemHeader === null) {
      throw new Error("An item header is not a JSON object.");
    }
    position = headerEnd + 1;

    const declaredLength = "length" in itemHeader ? itemHeader.length : undefined;
    let payloadEnd: number;
    if (typeof declaredLength === "number") {
      payloadEnd = position + declaredLength;
      if (payloadEnd !== envelope.length && envelope[payloadEnd] !== 10) {
        throw new Error("A length-delimited payload must end at the envelope's end or a newline.");
      }
    } else {
      payloadEnd = envelope.indexOf(10, position);
      payloadEnd = payloadEnd === -1 ? envelope.length : payloadEnd;
    }
    items.push({
      header: itemHeader,
      payload: decoder.decode(envelope.subarray(position, payloadEnd)),
    });
    position = payloadEnd + 1;
  }
  return { header, items };
}

function encode(...lines: string[]): Uint8Array {
  return new TextEncoder().encode(lines.join("\n"));
}

test("an event item gains the listener's country, with a correct length header", () => {
  const envelope = encode(
    ENVELOPE_HEADER,
    '{"type":"event"}',
    '{"event_id":"e1","message":"Hörbuch","user":{"id":"signed-out"}}',
  );

  const rewritten = parseEnvelope(rewriteTunnelEnvelope(envelope, "AT"));

  expect(rewritten.header).toBe(ENVELOPE_HEADER);
  expect(rewritten.items).toHaveLength(1);
  expect(rewritten.items[0]?.header).toStrictEqual({ type: "event", length: 93 });
  expect(JSON.parse(rewritten.items[0]?.payload ?? "")).toStrictEqual({
    event_id: "e1",
    message: "Hörbuch",
    user: { id: "signed-out", geo: { country_code: "AT" } },
  });
});

test.for(["XX", "T1"])(
  "a client's user.geo on a transaction is replaced by the reported country %s",
  (country) => {
    const envelope = encode(
      ENVELOPE_HEADER,
      '{"type":"transaction"}',
      '{"type":"transaction","user":{"id":"a1","geo":{"city":"Graz","country_code":"AT"}}}',
    );

    const [item] = parseEnvelope(rewriteTunnelEnvelope(envelope, country)).items;

    expect(JSON.parse(item?.payload ?? "")).toStrictEqual({
      type: "transaction",
      user: { id: "a1", geo: { country_code: country } },
    });
  },
);

test("an event without a user gains one with the country, next to items that pass unchanged", () => {
  const spanItemHeader =
    '{"type":"span","item_count":1,"content_type":"application/vnd.sentry.items.span.v2+json"}';
  const spanPayload =
    '{"items":[{"name":"GET /app/","attributes":{"user.geo.country_code":{"value":"DE"}}}]}';
  const attachmentItemHeader = '{"type":"attachment","length":4,"filename":"a.bin"}';
  const envelope = encode(
    ENVELOPE_HEADER,
    spanItemHeader,
    spanPayload,
    '{"type":"event","length":17}',
    '{"event_id":"e2"}',
    attachmentItemHeader,
    "a\nbc",
    '{"type":"client_report"}',
    '{"discarded_events":[]}',
  );

  const rewritten = parseEnvelope(rewriteTunnelEnvelope(envelope, "DE"));

  expect(rewritten.items).toStrictEqual([
    { header: JSON.parse(spanItemHeader), payload: spanPayload },
    {
      header: { type: "event", length: 54 },
      payload: '{"event_id":"e2","user":{"geo":{"country_code":"DE"}}}',
    },
    { header: JSON.parse(attachmentItemHeader), payload: "a\nbc" },
    { header: { type: "client_report" }, payload: '{"discarded_events":[]}' },
  ]);
});

test("a body that is no envelope is rejected", () => {
  expect(() => rewriteTunnelEnvelope(encode("not json"), "AT")).toThrow(
    "An envelope line is not JSON.",
  );
  expect(() =>
    rewriteTunnelEnvelope(
      encode(ENVELOPE_HEADER, '{"type":"attachment","length":10}', "short"),
      "AT",
    ),
  ).toThrow("An item is shorter than its declared length.");
});
