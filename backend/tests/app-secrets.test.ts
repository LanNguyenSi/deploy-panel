import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    appSecret: {
      findMany: vi.fn(),
      upsert: vi.fn().mockResolvedValue({}),
      delete: vi.fn(),
    },
  },
}));

vi.mock("../src/lib/secret-crypto.js", () => ({
  encryptSecretValue: vi.fn((v: string) => `enc(${v})`),
  decryptSecretValue: vi.fn((v: string) => v.replace(/^enc\(/, "").replace(/\)$/, "")),
}));

import { Prisma } from "@prisma/client";
import { prisma } from "../src/lib/prisma.js";
import { encryptSecretValue, decryptSecretValue } from "../src/lib/secret-crypto.js";
import {
  listMaskedAppSecrets,
  listAppSecretKeys,
  getDecryptedAppSecrets,
  setAppSecret,
  deleteAppSecret,
} from "../src/lib/app-secrets.js";

const mFindMany = (prisma.appSecret as any).findMany as ReturnType<typeof vi.fn>;
const mUpsert = (prisma.appSecret as any).upsert as ReturnType<typeof vi.fn>;
const mDelete = (prisma.appSecret as any).delete as ReturnType<typeof vi.fn>;

describe("app-secrets store", () => {
  beforeEach(() => vi.clearAllMocks());

  it("listMaskedAppSecrets never touches decryptSecretValue and never returns a value field", async () => {
    mFindMany.mockResolvedValue([
      { key: "METRICS_API_TOKEN", updatedAt: new Date("2026-06-01T00:00:00Z") },
      { key: "DB_PASSWORD", updatedAt: new Date("2026-06-02T00:00:00Z") },
    ]);

    const result = await listMaskedAppSecrets("app-1");

    expect(result).toEqual([
      { key: "METRICS_API_TOKEN", set: true, updatedAt: new Date("2026-06-01T00:00:00Z") },
      { key: "DB_PASSWORD", set: true, updatedAt: new Date("2026-06-02T00:00:00Z") },
    ]);
    // The masked listing must be constructible without ever decrypting.
    expect(decryptSecretValue).not.toHaveBeenCalled();
    // Prisma select must not have pulled the ciphertext column at all —
    // defense in depth so a future refactor can't accidentally serialize it.
    expect(mFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ select: { key: true, updatedAt: true } }),
    );
    for (const row of result as any[]) {
      expect(row).not.toHaveProperty("value");
      expect(row).not.toHaveProperty("valueCiphertext");
    }
  });

  it("listAppSecretKeys returns only key names, no decryption", async () => {
    mFindMany.mockResolvedValue([{ key: "A" }, { key: "B" }]);
    const keys = await listAppSecretKeys("app-1");
    expect(keys).toEqual(new Set(["A", "B"]));
    expect(decryptSecretValue).not.toHaveBeenCalled();
  });

  it("getDecryptedAppSecrets decrypts every row (provisioning-only path)", async () => {
    mFindMany.mockResolvedValue([
      { key: "METRICS_API_TOKEN", valueCiphertext: "enc(super-secret)" },
    ]);
    const result = await getDecryptedAppSecrets("app-1");
    expect(result).toEqual([{ key: "METRICS_API_TOKEN", value: "super-secret" }]);
  });

  it("setAppSecret encrypts the value before it reaches prisma.upsert", async () => {
    await setAppSecret("app-1", "METRICS_API_TOKEN", "super-secret");
    expect(encryptSecretValue).toHaveBeenCalledWith("super-secret");
    const call = mUpsert.mock.calls[0][0];
    expect(call.where).toEqual({ appId_key: { appId: "app-1", key: "METRICS_API_TOKEN" } });
    expect(call.create.valueCiphertext).toBe("enc(super-secret)");
    expect(call.update.valueCiphertext).toBe("enc(super-secret)");
  });

  it("deleteAppSecret returns true when a row was removed", async () => {
    mDelete.mockResolvedValue({});
    await expect(deleteAppSecret("app-1", "K")).resolves.toBe(true);
  });

  it("deleteAppSecret returns false (not a throw) when the row didn't exist", async () => {
    mDelete.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("not found", { code: "P2025", clientVersion: "5.22.0" }),
    );
    await expect(deleteAppSecret("app-1", "K")).resolves.toBe(false);
  });

  it("deleteAppSecret rethrows a non-P2025 error", async () => {
    mDelete.mockRejectedValue(new Error("connection reset"));
    await expect(deleteAppSecret("app-1", "K")).rejects.toThrow("connection reset");
  });
});
