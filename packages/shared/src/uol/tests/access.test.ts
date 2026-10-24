import { describe, it, expect } from "vitest";

import { assertAccess } from "../access";
import { OperationError } from "../errors";
import type { AccessRequirement } from "../types";
import type { Principal } from "../principal";

/** 各类型 Principal 的测试固定值 */
const principals = {
  user: {
    type: "user",
    userId: "u1",
    role: "user",
  } as Principal,
  admin: {
    type: "user",
    userId: "u2",
    role: "admin",
  } as Principal,
  superAdmin: {
    type: "user",
    userId: "u3",
    role: "super_admin",
  } as Principal,
  observerAdmin: {
    type: "user",
    userId: "u4",
    role: "observer_admin",
  } as Principal,
  apiKey: {
    type: "apiKey",
    userId: "u5",
    apiKeyId: "k1",
    plan: "pro",
    relayOnly: false,
  } as Principal,
  system: {
    type: "system",
    reason: "test",
  } as Principal,
  cron: {
    type: "cron",
    job: "daily-cleanup",
  } as Principal,
  webhookCreem: {
    type: "webhook",
    provider: "creem",
  } as Principal,
  webhookEpay: {
    type: "webhook",
    provider: "epay",
  } as Principal,
  proxy: {
    type: "proxy",
    secretKind: "proxy",
  } as Principal,
};

describe("UOL Access Control (assertAccess)", () => {
  describe("public", () => {
    const access: AccessRequirement = { kind: "public" };

    it("allows any principal for an explicitly read-only operation", () => {
      for (const p of Object.values(principals)) {
        expect(() =>
          assertAccess(access, p, { readOnly: true, destructive: false }),
        ).not.toThrow();
      }
    });
  });

  describe("protected", () => {
    const access: AccessRequirement = { kind: "protected" };

    it("allows user principals", () => {
      expect(() => assertAccess(access, principals.user)).not.toThrow();
      expect(() =>
        assertAccess(access, principals.admin),
      ).not.toThrow();
    });

    it("allows apiKey principals", () => {
      expect(() =>
        assertAccess(access, principals.apiKey),
      ).not.toThrow();
    });

    it("allows system principals", () => {
      expect(() =>
        assertAccess(access, principals.system),
      ).not.toThrow();
    });

    it("rejects cron / webhook / proxy principals", () => {
      expect(() => assertAccess(access, principals.cron)).toThrow(
        OperationError,
      );
      expect(() =>
        assertAccess(access, principals.webhookCreem),
      ).toThrow(OperationError);
      expect(() => assertAccess(access, principals.proxy)).toThrow(
        OperationError,
      );
    });
  });

  describe("admin", () => {
    const access: AccessRequirement = { kind: "admin" };

    it("allows admin and super_admin", () => {
      expect(() =>
        assertAccess(access, principals.admin),
      ).not.toThrow();
      expect(() =>
        assertAccess(access, principals.superAdmin),
      ).not.toThrow();
    });

    it("rejects observer_admin without operation read-only metadata", () => {
      expect(() =>
        assertAccess(access, principals.observerAdmin),
      ).toThrow(OperationError);
    });

    it("allows system principal", () => {
      expect(() =>
        assertAccess(access, principals.system),
      ).not.toThrow();
    });

    it("rejects regular user", () => {
      expect(() => assertAccess(access, principals.user)).toThrow(
        OperationError,
      );
    });

    it("rejects non-user principals", () => {
      expect(() => assertAccess(access, principals.apiKey)).toThrow(
        OperationError,
      );
      expect(() => assertAccess(access, principals.cron)).toThrow(
        OperationError,
      );
    });
  });

  describe("superAdmin", () => {
    const access: AccessRequirement = { kind: "superAdmin" };

    it("allows super_admin only", () => {
      expect(() =>
        assertAccess(access, principals.superAdmin),
      ).not.toThrow();
    });

    it("rejects admin (non-super)", () => {
      expect(() => assertAccess(access, principals.admin)).toThrow(
        OperationError,
      );
    });

    it("rejects regular user", () => {
      expect(() => assertAccess(access, principals.user)).toThrow(
        OperationError,
      );
    });

    it("allows system principal", () => {
      expect(() =>
        assertAccess(access, principals.system),
      ).not.toThrow();
    });
  });

  describe("imageBackendPoolViewer", () => {
    const access: AccessRequirement = {
      kind: "imageBackendPoolViewer",
    };

    it("requires operation read-only metadata for observer_admin", () => {
      expect(() => assertAccess(access, principals.observerAdmin)).toThrow(
        OperationError,
      );
    });

    it("allows admin and super_admin", () => {
      expect(() =>
        assertAccess(access, principals.admin),
      ).not.toThrow();
      expect(() =>
        assertAccess(access, principals.superAdmin),
      ).not.toThrow();
    });

    it("rejects regular user", () => {
      expect(() => assertAccess(access, principals.user)).toThrow(
        OperationError,
      );
    });

    it("rejects non-user principals", () => {
      expect(() => assertAccess(access, principals.apiKey)).toThrow(
        OperationError,
      );
    });

    it("allows system principal", () => {
      expect(() =>
        assertAccess(access, principals.system),
      ).not.toThrow();
    });
  });

  describe("apiKey", () => {
    const access: AccessRequirement = { kind: "apiKey" };

    it("allows apiKey principal", () => {
      expect(() =>
        assertAccess(access, principals.apiKey),
      ).not.toThrow();
    });

    it("rejects user principal", () => {
      expect(() => assertAccess(access, principals.user)).toThrow(
        OperationError,
      );
    });

    it("allows system principal", () => {
      expect(() =>
        assertAccess(access, principals.system),
      ).not.toThrow();
    });

    it("rejects cron principal", () => {
      expect(() => assertAccess(access, principals.cron)).toThrow(
        OperationError,
      );
    });
  });

  describe("cron", () => {
    const access: AccessRequirement = { kind: "cron" };

    it("allows cron principal", () => {
      expect(() =>
        assertAccess(access, principals.cron),
      ).not.toThrow();
    });

    it("rejects user principal", () => {
      expect(() => assertAccess(access, principals.user)).toThrow(
        OperationError,
      );
    });

    it("allows system principal", () => {
      expect(() =>
        assertAccess(access, principals.system),
      ).not.toThrow();
    });
  });

  describe("webhook", () => {
    it("allows matching webhook provider", () => {
      const creem: AccessRequirement = {
        kind: "webhook",
        provider: "creem",
      };
      expect(() =>
        assertAccess(creem, principals.webhookCreem),
      ).not.toThrow();

      const epay: AccessRequirement = {
        kind: "webhook",
        provider: "epay",
      };
      expect(() =>
        assertAccess(epay, principals.webhookEpay),
      ).not.toThrow();
    });

    it("rejects mismatched webhook provider", () => {
      const creem: AccessRequirement = {
        kind: "webhook",
        provider: "creem",
      };
      expect(() =>
        assertAccess(creem, principals.webhookEpay),
      ).toThrow(OperationError);
    });

    it("rejects non-webhook principals", () => {
      const creem: AccessRequirement = {
        kind: "webhook",
        provider: "creem",
      };
      expect(() => assertAccess(creem, principals.user)).toThrow(
        OperationError,
      );
    });

    it("allows system principal", () => {
      const creem: AccessRequirement = {
        kind: "webhook",
        provider: "creem",
      };
      expect(() =>
        assertAccess(creem, principals.system),
      ).not.toThrow();
    });
  });

  describe("proxySecret", () => {
    const access: AccessRequirement = { kind: "proxySecret" };

    it("allows proxy principal", () => {
      expect(() =>
        assertAccess(access, principals.proxy),
      ).not.toThrow();
    });

    it("rejects non-proxy principals", () => {
      expect(() => assertAccess(access, principals.user)).toThrow(
        OperationError,
      );
      expect(() => assertAccess(access, principals.apiKey)).toThrow(
        OperationError,
      );
    });

    it("allows system principal", () => {
      expect(() =>
        assertAccess(access, principals.system),
      ).not.toThrow();
    });
  });

  describe("owner", () => {
    const access: AccessRequirement = {
      kind: "owner",
      resource: "generation",
    };

    it("allows user principal (defers ownership check to execute)", () => {
      expect(() => assertAccess(access, principals.user)).not.toThrow();
    });

    it("allows apiKey principal", () => {
      expect(() =>
        assertAccess(access, principals.apiKey),
      ).not.toThrow();
    });

    it("allows system principal", () => {
      expect(() =>
        assertAccess(access, principals.system),
      ).not.toThrow();
    });

    it("rejects cron / webhook / proxy (no user identity)", () => {
      expect(() => assertAccess(access, principals.cron)).toThrow(
        OperationError,
      );
      expect(() =>
        assertAccess(access, principals.webhookCreem),
      ).toThrow(OperationError);
      expect(() => assertAccess(access, principals.proxy)).toThrow(
        OperationError,
      );
    });
  });

  describe("system", () => {
    const access: AccessRequirement = { kind: "system" };

    it("allows system principal only", () => {
      expect(() =>
        assertAccess(access, principals.system),
      ).not.toThrow();
    });

    it("rejects all non-system principals", () => {
      expect(() => assertAccess(access, principals.user)).toThrow(
        OperationError,
      );
      expect(() => assertAccess(access, principals.admin)).toThrow(
        OperationError,
      );
      expect(() =>
        assertAccess(access, principals.superAdmin),
      ).toThrow(OperationError);
      expect(() => assertAccess(access, principals.apiKey)).toThrow(
        OperationError,
      );
      expect(() => assertAccess(access, principals.cron)).toThrow(
        OperationError,
      );
      expect(() =>
        assertAccess(access, principals.webhookCreem),
      ).toThrow(OperationError);
      expect(() => assertAccess(access, principals.proxy)).toThrow(
        OperationError,
      );
    });
  });

  describe("system principal bypasses all access checks", () => {
    const allAccessKinds: AccessRequirement[] = [
      { kind: "public" },
      { kind: "protected" },
      { kind: "owner", resource: "test" },
      { kind: "admin" },
      { kind: "superAdmin" },
      { kind: "imageBackendPoolViewer" },
      { kind: "apiKey" },
      { kind: "cron" },
      { kind: "webhook", provider: "creem" },
      { kind: "proxySecret" },
      { kind: "system" },
    ];

    for (const access of allAccessKinds) {
      it(`bypasses "${access.kind}" access`, () => {
        expect(() =>
          assertAccess(access, principals.system),
        ).not.toThrow();
      });
    }
  });
});
