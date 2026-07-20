import "dotenv/config";
import { PrismaClient } from "../lib/generated/prisma/client";
import { PrismaNeon } from "@prisma/adapter-neon";
import { hashPassword, MIN_OPERATOR_PASSWORD_LENGTH, InvalidPasswordError } from "../lib/auth/password";

// Manual, one-off operator provisioning — run locally with production
// DATABASE_URL access. Never an HTTP endpoint: this script requires the
// same DB access level the project owner already has, so it adds no new
// internet-facing attack surface (see OPERATOR_AUTH_AUDIT.md §6, "First
// operator account creation").
//
// Reuses `phone` (already unique on Operator) as the login identifier
// rather than adding a new email field — see
// docs/OPERATOR_AUTH_IMPLEMENTATION.md for why.
//
// Creates the operator if it doesn't exist yet, or updates its password (and
// name) if it does — safe to re-run to rotate a password.
//
// Usage:
//   OPERATOR_NAME="Jane Operator" OPERATOR_PHONE="+41000000000" \
//   OPERATOR_PASSWORD="a-long-random-password" npm run operator:create

const adapter = new PrismaNeon({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function main() {
  const name = process.env.OPERATOR_NAME?.trim();
  const phone = process.env.OPERATOR_PHONE?.trim();
  const password = process.env.OPERATOR_PASSWORD;

  if (!name || !phone || !password) {
    console.error(
      "Missing required environment variables. Set OPERATOR_NAME, OPERATOR_PHONE, and OPERATOR_PASSWORD.",
    );
    process.exitCode = 1;
    return;
  }

  let passwordHash: string;
  try {
    passwordHash = await hashPassword(password);
  } catch (err) {
    if (err instanceof InvalidPasswordError) {
      console.error(`OPERATOR_PASSWORD must be at least ${MIN_OPERATOR_PASSWORD_LENGTH} characters.`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  const existing = await prisma.operator.findUnique({ where: { phone } });

  const operator = await prisma.operator.upsert({
    where: { phone },
    create: { name, phone, passwordHash },
    update: { name, passwordHash },
  });

  // Safe summary only — never the password or its hash.
  console.log(
    existing
      ? `Updated password for existing operator "${operator.name}" (${operator.phone}, id ${operator.id}).`
      : `Created operator "${operator.name}" (${operator.phone}, id ${operator.id}).`,
  );
}

main()
  .catch((err) => {
    console.error("operator:create failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
