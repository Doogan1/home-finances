import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { rotateTokenKeys } from "@/features/plaid/key-rotation";
import { createTokenCipher, plaidItemTokenContext, tokenKeyId } from "@/lib/crypto/tokens";
import { seedPerson } from "./helpers/plaid-fixtures";
import { createTestClient, truncateAll } from "./helpers/test-db";

// Rotating the token-encryption key: every stored access token is re-encrypted
// under the new key without ever being lost. Synthetic keys and tokens only.

const { ownerUrl, appUrl } = inject("testDatabase");

const OLD = { keyId: "v1", key: Buffer.alloc(32, 1) };
const NEW = { keyId: "v2", key: Buffer.alloc(32, 2) };
const UNKNOWN = { keyId: "v0", key: Buffer.alloc(32, 9) };

const oldCipher = createTokenCipher({ current: OLD });
const rotatedCipher = createTokenCipher({ current: NEW, retired: [OLD] });
const vault = { encrypt: rotatedCipher.encryptToken, decrypt: rotatedCipher.decryptToken };

let owner: PrismaClient;
let app: PrismaClient;
let householdId: string;

beforeAll(() => {
  owner = createTestClient(ownerUrl);
  app = createTestClient(appUrl);
});
afterAll(async () => {
  await owner.$disconnect();
  await app.$disconnect();
});
beforeEach(async () => {
  await truncateAll(owner);
  householdId = (await seedPerson(owner, "a@example.test")).householdId;
});

async function item(plaidItemId: string, token: string | null, cipher = oldCipher, environment: "SANDBOX" | "PRODUCTION" = "SANDBOX") {
  return owner.plaidItem.create({
    data: {
      householdId,
      environment,
      plaidItemId,
      status: token ? "ACTIVE" : "DISCONNECTED",
      accessTokenCiphertext: token ? cipher.encryptToken(token, plaidItemTokenContext(environment, plaidItemId)) : null,
    },
  });
}
const ciphertextOf = async (id: string) => (await owner.plaidItem.findUniqueOrThrow({ where: { id } })).accessTokenCiphertext;
const rotate = (apply: boolean, db: PrismaClient = app) => rotateTokenKeys({ db, tokens: vault, currentKeyId: NEW.keyId }, { apply });

describe("tokenKeyId", () => {
  it("reads the key label without decrypting, and rejects anything malformed", () => {
    const stored = oldCipher.encryptToken("tok", "ctx");

    expect(tokenKeyId(stored)).toBe("v1");
    for (const bad of ["", "garbage", "v2.k.a.b", "v1.bad key.a.b.c", "x1.k.a.b.c"]) expect(tokenKeyId(bad)).toBeNull();
  });
});

describe("rotateTokenKeys", () => {
  it("dry run reports what would change and changes nothing", async () => {
    const a = await item("item_a", "access-sandbox-a");
    const before = await ciphertextOf(a.id);

    const report = await rotate(false);

    expect(report).toMatchObject({ dryRun: true, examined: 1, rotated: 1, alreadyCurrent: 0, unreadable: [], changedConcurrently: 0 });
    expect(await ciphertextOf(a.id)).toBe(before);
  });

  it("re-encrypts every token under the current key, preserving each one exactly", async () => {
    const a = await item("item_a", "access-sandbox-a");
    const b = await item("item_b", "access-sandbox-b");
    const live = await item("item_c", "access-production-c", oldCipher, "PRODUCTION");
    await item("item_closed", null); // disconnected: nothing stored, nothing to do

    const report = await rotate(true);

    expect(report).toMatchObject({ dryRun: false, examined: 3, rotated: 3, alreadyCurrent: 0, unreadable: [] });
    for (const [row, token, env, pid] of [
      [a, "access-sandbox-a", "SANDBOX", "item_a"],
      [b, "access-sandbox-b", "SANDBOX", "item_b"],
      [live, "access-production-c", "PRODUCTION", "item_c"],
    ] as const) {
      const stored = (await ciphertextOf(row.id))!;
      expect(tokenKeyId(stored)).toBe("v2");
      expect(stored).not.toContain(token);
      // Readable with the new key alone: the retired key is no longer needed.
      expect(createTokenCipher({ current: NEW }).decryptToken(stored, plaidItemTokenContext(env, pid))).toBe(token);
    }
  });

  it("is idempotent: running again finds everything already current", async () => {
    await item("item_a", "access-sandbox-a");
    await rotate(true);

    const second = await rotate(true);

    expect(second).toMatchObject({ examined: 1, alreadyCurrent: 1, rotated: 0 });
  });

  it("reports an unreadable token without touching it, and still rotates the rest", async () => {
    const lost = await item("item_lost", "access-sandbox-lost", createTokenCipher({ current: UNKNOWN }));
    const fine = await item("item_fine", "access-sandbox-fine");
    const lostBefore = await ciphertextOf(lost.id);

    const report = await rotate(true);

    expect(report.unreadable).toEqual([lost.id]);
    expect(report.rotated).toBe(1);
    expect(await ciphertextOf(lost.id)).toBe(lostBefore);
    expect(tokenKeyId((await ciphertextOf(fine.id))!)).toBe("v2");
    // Ids only: never a token, a ciphertext or a key.
    expect(JSON.stringify(report)).not.toMatch(/access-sandbox|v1\.v0|AAAA/);
  });

  it("does not overwrite a token that changed while it was being rotated", async () => {
    const a = await item("item_a", "access-sandbox-a");
    // A different writer changes the row between our read and our write.
    const racing = new Proxy(app, {
      get(target, prop) {
        if (prop === "plaidItem") {
          return new Proxy(target.plaidItem, {
            get(model, method) {
              if (method === "updateMany") {
                return async (args: Parameters<typeof model.updateMany>[0]) => {
                  await owner.plaidItem.update({ where: { id: a.id }, data: { accessTokenCiphertext: "changed-by-someone-else" } });
                  return model.updateMany(args);
                };
              }
              return Reflect.get(model, method, model);
            },
          });
        }
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as PrismaClient;

    const report = await rotate(true, racing);

    expect(report).toMatchObject({ rotated: 0, changedConcurrently: 1 });
    expect(await ciphertextOf(a.id)).toBe("changed-by-someone-else");
  });

  it("handles more rows than one batch", async () => {
    for (let i = 0; i < 7; i++) await item(`item_${i}`, `access-sandbox-${i}`);

    const report = await rotateTokenKeys({ db: app, tokens: vault, currentKeyId: NEW.keyId }, { apply: true, batchSize: 3 });

    expect(report).toMatchObject({ examined: 7, rotated: 7 });
  });
});
