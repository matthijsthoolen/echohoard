import { describe, expect, it } from "vitest";
import {
  WHATSAPP_ADAPTER_CONTRACT_VERSION,
  selectWhatsAppAndroidAdapter,
  type SqliteSchemaShape,
} from "./contract.js";

const current: SqliteSchemaShape = {
  message: ["_id", "chat_row_id", "from_me", "timestamp", "message_type", "text_data"],
  chat: ["_id", "jid_row_id", "subject"],
  jid: ["_id", "raw_string"],
};

const legacy: SqliteSchemaShape = {
  messages: ["_id", "key_remote_jid", "key_from_me", "timestamp", "media_wa_type", "data"],
};

describe("WhatsApp Android adapter schema contract", () => {
  it("selects the current structural fingerprint", () => {
    const result = selectWhatsAppAndroidAdapter(current);
    expect(result).toEqual({
      kind: "supported",
      fingerprint: "android-current.v1",
      adapter: {
        version: "android-current.v1",
        contractVersion: WHATSAPP_ADAPTER_CONTRACT_VERSION,
      },
    });
  });

  it("selects the relevant legacy structural fingerprint", () => {
    expect(selectWhatsAppAndroidAdapter(legacy)).toMatchObject({
      kind: "supported",
      fingerprint: "android-legacy.v1",
    });
  });

  it("fails closed when both families match", () => {
    const result = selectWhatsAppAndroidAdapter({ ...current, ...legacy });
    expect(result).toEqual({
      kind: "unsupported",
      reason: "ambiguous",
      diagnostic: "ambiguous-whatsapp-schema",
    });
  });

  it("fails closed for an unknown or incomplete schema", () => {
    const result = selectWhatsAppAndroidAdapter({ message: ["_id", "text_data"] });
    expect(result).toEqual({
      kind: "unsupported",
      reason: "unknown",
      diagnostic: "unsupported-whatsapp-schema",
    });
  });

  it("does not expose database vocabulary through normalized records", () => {
    const result = selectWhatsAppAndroidAdapter(current);
    expect(JSON.stringify(result)).not.toMatch(/row_id|message_type|text_data|key_remote_jid/);
  });
});
