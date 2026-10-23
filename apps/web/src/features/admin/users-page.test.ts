/** 管理员用户页回归：SSR 取数前守住会话/角色，默认列表与时区并行读取。 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import DashboardAdminUsersPage from "@/app/[locale]/(dashboard)/dashboard/admin/users/page";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  role: vi.fn(),
  snapshot: vi.fn(),
  timeZone: vi.fn(),
}));
vi.mock("@repo/shared/auth/server", () => ({
  getServerSession: mocks.session,
}));
vi.mock("@repo/shared/auth/role-server", () => ({
  getUserRoleById: mocks.role,
}));
vi.mock("@repo/shared/support/services/admin-users-list", () => ({
  getAdminUsersListSnapshot: mocks.snapshot,
}));
vi.mock("@repo/shared/time-zone/server", () => ({
  getAppTimeZone: mocks.timeZone,
}));
vi.mock("@repo/shared/support/components/admin-users-management", () => ({
  AdminUsersManagement: () => null,
}));
vi.mock("next-intl/server", () => ({ getLocale: async () => "zh" }));
vi.mock("next/navigation", () => ({
  redirect: (href: string) => {
    throw new Error(`redirect:${href}`);
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.mockResolvedValue({ user: { id: "admin-1" } });
  mocks.role.mockResolvedValue("admin");
  mocks.timeZone.mockResolvedValue("UTC");
  mocks.snapshot.mockResolvedValue({
    users: [],
    pagination: { page: 1, pageSize: 20, total: 0 },
    stats: { totalUsers: 0, admins: 0, banned: 0, activeSubscriptions: 0 },
  });
});

describe("DashboardAdminUsersPage", () => {
  it.each(["observer_admin", "user"])("%s 在取数之前重定向", async (role) => {
    mocks.role.mockResolvedValue(role);
    await expect(DashboardAdminUsersPage()).rejects.toThrow(
      "redirect:/zh/dashboard"
    );
    expect(mocks.snapshot).not.toHaveBeenCalled();
    expect(mocks.timeZone).not.toHaveBeenCalled();
  });

  it.each([
    null,
    { user: { id: "banned-admin", banned: true } },
  ])("匿名或被封禁会话不能预取用户列表", async (session) => {
    mocks.session.mockResolvedValue(session);
    await expect(DashboardAdminUsersPage()).rejects.toThrow(
      "redirect:/zh/sign-in"
    );
    expect(mocks.role).not.toHaveBeenCalled();
    expect(mocks.snapshot).not.toHaveBeenCalled();
  });

  it.each([
    "admin",
    "super_admin",
  ])("%s 通过鉴权后并行读取并传递初值", async (role) => {
    mocks.role.mockResolvedValue(role);
    let started: () => void = () => undefined;
    const timeZoneStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finish: (value: string) => void = () => undefined;
    mocks.timeZone.mockImplementation(() => {
      started();
      return new Promise<string>((resolve) => {
        finish = resolve;
      });
    });
    const page = DashboardAdminUsersPage();
    await timeZoneStarted;
    expect(mocks.snapshot).toHaveBeenCalledExactlyOnceWith(undefined, role);
    finish("Asia/Shanghai");
    const element = await page;
    expect(element.props).toMatchObject({
      canManageRoles: role === "super_admin",
      timeZone: "Asia/Shanghai",
      initialData: {
        users: [],
        pagination: { page: 1, pageSize: 20, total: 0 },
      },
    });
  });
});
