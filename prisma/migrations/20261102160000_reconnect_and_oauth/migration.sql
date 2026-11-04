-- Task 5: distinguish reconnect (update mode) attempts from new connections, and
-- hold the short-lived, encrypted link token an OAuth redirect page needs.
-- Generated with `prisma migrate diff`. Purely additive.

-- CreateEnum
CREATE TYPE "LinkAttemptKind" AS ENUM ('CONNECT', 'RECONNECT');

-- AlterTable
ALTER TABLE "LinkAttempt" ADD COLUMN     "kind" "LinkAttemptKind" NOT NULL DEFAULT 'CONNECT',
ADD COLUMN     "linkTokenCiphertext" TEXT;
