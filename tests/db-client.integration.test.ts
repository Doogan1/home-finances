import { afterAll, describe, expect, inject, it } from "vitest";
import { createDbClient } from "@/lib/db";

// createDbClient is the exact factory the app uses; here it is pointed at the
// throwaway test database as the restricted application role.
const { appUrl } = inject("testDatabase");
const db = createDbClient(appUrl);

afterAll(async () => {
  await db.$disconnect();
});

describe("createDbClient (restricted app role)", () => {
  it("performs normal reads and writes through Prisma", async () => {
    const household = await db.household.create({ data: { name: "Via app role" } });
    const found = await db.household.findUniqueOrThrow({ where: { id: household.id } });

    expect(found.name).toBe("Via app role");

    await db.household.delete({ where: { id: household.id } });
    expect(await db.household.count({ where: { id: household.id } })).toBe(0);
  });

  it("is connected as the app role, not the owner", async () => {
    const rows = await db.$queryRaw<{ current_user: string }[]>`select current_user`;

    expect(rows[0].current_user).toBe(process.env.APP_DB_USER);
  });
});
