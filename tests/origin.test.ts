import { describe, expect, it } from "vitest";
import { checkMutationOrigin, isLoopbackHost, shouldUseSecureCookies } from "@/lib/auth/origin";

const APP_URL = "http://localhost:3000";

function request(method: string, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost:3000/api/anything", { method, headers });
}

describe("checkMutationOrigin", () => {
  it("allows a same-origin POST", () => {
    expect(checkMutationOrigin(request("POST", { origin: APP_URL }), APP_URL)).toBeNull();
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])("rejects a cross-origin %s", async (method) => {
    const response = checkMutationOrigin(request(method, { origin: "https://evil.example" }), APP_URL);

    expect(response?.status).toBe(403);
  });

  it("rejects a mutation with no Origin header", () => {
    expect(checkMutationOrigin(request("POST"), APP_URL)?.status).toBe(403);
  });

  it("rejects the opaque 'null' origin", () => {
    expect(checkMutationOrigin(request("POST", { origin: "null" }), APP_URL)?.status).toBe(403);
  });

  it("rejects look-alike origins (different port, scheme, or suffix)", () => {
    for (const origin of [
      "http://localhost:3001",
      "https://localhost:3000",
      "http://localhost:3000.evil.example",
      "http://evil.example/http://localhost:3000",
    ]) {
      expect(checkMutationOrigin(request("POST", { origin }), APP_URL)?.status).toBe(403);
    }
  });

  it("does not use Referer as a substitute for Origin", () => {
    const response = checkMutationOrigin(request("POST", { referer: `${APP_URL}/page` }), APP_URL);

    expect(response?.status).toBe(403);
  });

  it("ignores safe methods", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      expect(checkMutationOrigin(request(method), APP_URL)).toBeNull();
    }
  });

  it("returns a body that reveals nothing about the configured origin", async () => {
    const response = checkMutationOrigin(request("POST", { origin: "https://evil.example" }), APP_URL);
    const text = await response!.text();

    expect(text).not.toContain("localhost");
  });
});

describe("shouldUseSecureCookies", () => {
  it("is true for https", () => {
    expect(shouldUseSecureCookies("https://finance.example.test")).toBe(true);
  });

  it.each(["http://localhost:3000", "http://127.0.0.1:3000", "http://app.localhost:3000"])(
    "is false for loopback development over http (%s)",
    (url) => {
      expect(shouldUseSecureCookies(url)).toBe(false);
    },
  );

  it("refuses plain http anywhere else", () => {
    expect(() => shouldUseSecureCookies("http://finance.example.test")).toThrow(/https/);
    expect(() => shouldUseSecureCookies("http://192.168.1.10:3000")).toThrow(/https/);
  });

  it("does not treat look-alike hosts as loopback", () => {
    expect(isLoopbackHost("localhost.evil.example")).toBe(false);
    expect(isLoopbackHost("evil-localhost")).toBe(false);
  });
});
