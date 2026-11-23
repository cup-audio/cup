import { CupError } from "@cup/errors";

const ITEM_TYPES_WITH_USER = new Set(["event", "transaction"]);

const NEWLINE = 10;

type EnvelopeItem = {
  header: Uint8Array;
  payload: Uint8Array;
};

export class InvalidTunnelEnvelopeError extends CupError {
  override name = "InvalidTunnelEnvelopeError";
}

export function readEnvelopeDsn(envelope: Uint8Array): string | undefined {
  const header = parseJsonObject(splitEnvelope(envelope).header);
  return typeof header["dsn"] === "string" ? header["dsn"] : undefined;
}

export function rewriteTunnelEnvelope(
  envelope: Uint8Array,
  country: string | undefined,
): Uint8Array<ArrayBuffer> {
  const { header, items } = splitEnvelope(envelope);
  parseJsonObject(header);

  const parts: Uint8Array[] = [header];
  for (const item of items) {
    const itemHeader = parseJsonObject(item.header);
    if (typeof itemHeader["type"] !== "string" || !ITEM_TYPES_WITH_USER.has(itemHeader["type"])) {
      parts.push(new Uint8Array([NEWLINE]), item.header, new Uint8Array([NEWLINE]), item.payload);
      continue;
    }

    const payload = new TextEncoder().encode(
      JSON.stringify(withCountry(parseJsonObject(item.payload), country)),
    );
    const rewrittenHeader = new TextEncoder().encode(
      JSON.stringify({ ...itemHeader, length: payload.length }),
    );
    parts.push(new Uint8Array([NEWLINE]), rewrittenHeader, new Uint8Array([NEWLINE]), payload);
  }
  return concatBytes(parts);
}

function withCountry(event: Record<string, unknown>, country: string | undefined) {
  const user = isJsonObject(event["user"]) ? { ...event["user"] } : {};
  delete user["geo"];
  if (country !== undefined) {
    user["geo"] = { country_code: country };
  }
  return { ...event, user };
}

function splitEnvelope(envelope: Uint8Array): { header: Uint8Array; items: EnvelopeItem[] } {
  const headerEnd = indexOfNewline(envelope, 0);
  const header = envelope.subarray(0, headerEnd);

  const items: EnvelopeItem[] = [];
  let position = headerEnd + 1;
  while (position < envelope.length) {
    const itemHeaderEnd = indexOfNewline(envelope, position);
    const itemHeader = envelope.subarray(position, itemHeaderEnd);
    position = itemHeaderEnd + 1;
    if (itemHeader.length === 0) {
      continue;
    }

    const declaredLength = parseJsonObject(itemHeader)["length"];
    let payloadEnd: number;
    if (declaredLength === undefined) {
      payloadEnd = indexOfNewline(envelope, position);
    } else {
      if (
        typeof declaredLength !== "number" ||
        !Number.isInteger(declaredLength) ||
        declaredLength < 0
      ) {
        throw new InvalidTunnelEnvelopeError("An item header declares an invalid length.");
      }
      payloadEnd = position + declaredLength;
      if (payloadEnd > envelope.length) {
        throw new InvalidTunnelEnvelopeError("An item is shorter than its declared length.");
      }
    }
    items.push({ header: itemHeader, payload: envelope.subarray(position, payloadEnd) });
    position = payloadEnd + 1;
  }
  return { header, items };
}

function indexOfNewline(envelope: Uint8Array, from: number): number {
  const index = envelope.indexOf(NEWLINE, from);
  return index === -1 ? envelope.length : index;
}

function parseJsonObject(bytes: Uint8Array): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new InvalidTunnelEnvelopeError("An envelope line is not JSON.");
  }
  if (!isJsonObject(value)) {
    throw new InvalidTunnelEnvelopeError("An envelope line is not a JSON object.");
  }
  return value;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function concatBytes(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
