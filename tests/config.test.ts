import { describe, expect, it } from "vitest";
import { getServerConfig } from "@/lib/config";

// 32 bytes of 0x01, base64-encoded. A synthetic value, not a real key.
const TEST_KEY = Buffer.alloc(32, 1).toString("base64");
const TEST_AUTH_SECRET = "a".repeat(32);

const validEnv: Record<string, string> = {
  DATABASE_URL: "postgresql://user:pw-secret-123@db:5432/home_finances",
  PLAID_ENV: "sandbox",
  TOKEN_ENCRYPTION_KEY: TEST_KEY,
  TOKEN_ENCRYPTION_KEY_ID: "v1",
  AUTH_SECRET: TEST_AUTH_SECRET,
  APP_URL: "http://localhost:3000",
};

function without(env: Record<string, string>, key: string) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => name !== key));
}

describe("getServerConfig", () => {
  it("returns typed settings for a valid environment", () => {
    const config = getServerConfig(validEnv);

    expect(config.plaidEnv).toBe("sandbox");
    expect(config.appUrl).toBe("http://localhost:3000");
    expect(config.tokenEncryption.keyId).toBe("v1");
    expect(config.tokenEncryption.key).toHaveLength(32);
  });

  it("defaults PLAID_ENV to sandbox", () => {
    const env = without(validEnv, "PLAID_ENV");
    expect(getServerConfig(env).plaidEnv).toBe("sandbox");
  });

  it("rejects a missing DATABASE_URL without echoing any value", () => {
    const env = without(validEnv, "DATABASE_URL");

    expect(() => getServerConfig(env)).toThrow(/DATABASE_URL/);
  });

  it("rejects an invalid PLAID_ENV without echoing the value", () => {
    const env = { ...validEnv, PLAID_ENV: "banana-stand" };

    expect(() => getServerConfig(env)).toThrow(/PLAID_ENV/);
    expect(() => getServerConfig(env)).not.toThrow(/banana-stand/);
  });

  it("does not accept a legacy development Plaid environment", () => {
    const env = { ...validEnv, PLAID_ENV: "development" };

    expect(() => getServerConfig(env)).toThrow(/PLAID_ENV/);
  });

  it("rejects a malformed encryption key without echoing the value", () => {
    const badKey = "not-a-real-key-but-very-secret";
    const env = { ...validEnv, TOKEN_ENCRYPTION_KEY: badKey };

    expect(() => getServerConfig(env)).toThrow(/TOKEN_ENCRYPTION_KEY/);
    expect(() => getServerConfig(env)).not.toThrow(new RegExp(badKey));
  });

  it("rejects an encryption key of the wrong length", () => {
    const shortKey = Buffer.alloc(16, 1).toString("base64");
    const env = { ...validEnv, TOKEN_ENCRYPTION_KEY: shortKey };

    expect(() => getServerConfig(env)).toThrow(/TOKEN_ENCRYPTION_KEY/);
  });

  it("rejects a short AUTH_SECRET without echoing the value", () => {
    const env = { ...validEnv, AUTH_SECRET: "short-secret" };

    expect(() => getServerConfig(env)).toThrow(/AUTH_SECRET/);
    expect(() => getServerConfig(env)).not.toThrow(/short-secret/);
  });

  it("never includes the database password in an error", () => {
    const env = { ...validEnv, DATABASE_URL: "mysql://user:pw-secret-123@db/x" };

    expect(() => getServerConfig(env)).toThrow(/DATABASE_URL/);
    expect(() => getServerConfig(env)).not.toThrow(/pw-secret-123/);
  });

  it("treats the Plaid credentials as optional until Plaid is wired up", () => {
    const config = getServerConfig(validEnv);

    expect(config.plaid).toBeNull();
  });

  it("returns Plaid credentials when both are present", () => {
    const config = getServerConfig({
      ...validEnv,
      PLAID_CLIENT_ID: "client-id",
      PLAID_SECRET: "plaid-secret",
    });

    expect(config.plaid).toEqual({ clientId: "client-id", secret: "plaid-secret" });
  });

  it("rejects a half-configured Plaid credential pair", () => {
    const env = { ...validEnv, PLAID_CLIENT_ID: "client-id" };

    expect(() => getServerConfig(env)).toThrow(/PLAID_SECRET/);
  });

  describe("PLAID_REDIRECT_URI", () => {
    const withUri = (uri: string, plaidEnv = "sandbox") => ({
      ...validEnv,
      PLAID_ENV: plaidEnv,
      PLAID_LIVE_OPT_IN: "yes",
      PLAID_REDIRECT_URI: uri,
    });

    it("is optional and null when unset or blank", () => {
      expect(getServerConfig(validEnv).plaidRedirectUri).toBeNull();
      expect(getServerConfig({ ...validEnv, PLAID_REDIRECT_URI: "" }).plaidRedirectUri).toBeNull();
    });

    it.each([
      ["https://finance.example.test/plaid/oauth", "sandbox"],
      ["https://finance.example.test/plaid/oauth", "production"],
      ["http://localhost:3000/plaid/oauth", "sandbox"],
      ["http://127.0.0.1:3000/plaid/oauth", "sandbox"],
    ])("accepts %s in %s", (uri, plaidEnv) => {
      expect(getServerConfig(withUri(uri, plaidEnv)).plaidRedirectUri).toBe(uri);
    });

    it.each([
      ["plain http on a real host", "http://finance.example.test/plaid/oauth", "sandbox"],
      ["http localhost in production", "http://localhost:3000/plaid/oauth", "production"],
      ["a query string", "https://finance.example.test/plaid/oauth?x=1", "sandbox"],
      ["a fragment", "https://finance.example.test/plaid/oauth#top", "sandbox"],
      ["embedded credentials", "https://user:pw@finance.example.test/plaid/oauth", "sandbox"],
      ["a custom scheme", "myapp://oauth", "sandbox"],
      ["not a URL", "not a url", "sandbox"],
    ])("rejects %s without echoing it", (_name, uri, plaidEnv) => {
      let message = "";
      try {
        getServerConfig(withUri(uri, plaidEnv));
      } catch (error) {
        message = String((error as Error).message);
      }

      expect(message).toContain("PLAID_REDIRECT_URI");
      expect(message).not.toContain(uri);
    });
  });

  describe("live (production) opt-in", () => {
    it("defaults to sandbox and needs nothing extra there", () => {
      expect(getServerConfig(validEnv).plaidEnv).toBe("sandbox");
      expect(getServerConfig({ ...validEnv, PLAID_LIVE_OPT_IN: "no" }).plaidEnv).toBe("sandbox");
    });

    it.each([[undefined], [""], ["true"], ["YES"], ["1"], ["y"]])(
      "refuses PLAID_ENV=production without the exact opt-in (%j)",
      (optIn) => {
        const env: Record<string, string> = { ...validEnv, PLAID_ENV: "production" };
        if (optIn !== undefined) env.PLAID_LIVE_OPT_IN = optIn;

        expect(() => getServerConfig(env)).toThrow(/PLAID_LIVE_OPT_IN/);
      },
    );

    it("allows production once PLAID_LIVE_OPT_IN=yes is set deliberately", () => {
      const config = getServerConfig({ ...validEnv, PLAID_ENV: "production", PLAID_LIVE_OPT_IN: "yes" });

      expect(config.plaidEnv).toBe("production");
    });
  });

  describe("TOKEN_ENCRYPTION_RETIRED_KEYS", () => {
    const oldKey = Buffer.alloc(32, 7).toString("base64");
    const otherKey = Buffer.alloc(32, 8).toString("base64");
    const withRetired = (value: string) => ({ ...validEnv, TOKEN_ENCRYPTION_RETIRED_KEYS: value });

    it("is empty when unset or blank", () => {
      expect(getServerConfig(validEnv).tokenEncryption.retired).toEqual([]);
      expect(getServerConfig(withRetired("")).tokenEncryption.retired).toEqual([]);
    });

    it("parses one or several id:key pairs, ignoring spaces", () => {
      const config = getServerConfig(withRetired("v0:" + oldKey + " , old2:" + otherKey));

      expect(config.tokenEncryption.retired.map((k) => k.keyId)).toEqual(["v0", "old2"]);
      expect(config.tokenEncryption.retired[0].key).toEqual(Buffer.alloc(32, 7));
      expect(config.tokenEncryption.keyId).toBe("v1"); // the current key is unchanged
    });

    it.each([
      ["a pair with no id", oldKey],
      ["a key of the wrong size", "v0:" + Buffer.alloc(16, 1).toString("base64")],
      ["an unsafe id", "bad.id:" + oldKey],
      ["an id equal to the current key's", "v1:" + oldKey],
      ["the same id twice", "v0:" + oldKey + ",v0:" + otherKey],
      ["a trailing comma", "v0:" + oldKey + ","],
    ])("rejects %s without echoing any key", (_name, value) => {
      let message = "";
      try {
        getServerConfig(withRetired(value));
      } catch (error) {
        message = String((error as Error).message);
      }

      expect(message).toContain("TOKEN_ENCRYPTION_RETIRED_KEYS");
      expect(message).not.toContain(oldKey);
      expect(message).not.toContain(otherKey);
    });
  });
});
