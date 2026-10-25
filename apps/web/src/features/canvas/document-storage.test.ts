/** 恢复稿必须在 IDB 持续不可用时仍可读取和导出，用户重试则重新尝试打开存储。 */
import { describe, expect, it, vi } from "vitest";
import { readCanvasDocument, saveCanvasDocument } from "./document-storage";

const state = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("./persistence", () => ({ openCanvasStorage: state.open }));

describe("画布故障恢复", () => {
  it("写入失败后，IDB 连打开都失败也不阻止取回最新内存稿", async () => {
    state.open.mockRejectedValue(new Error("storage unavailable"));
    await expect(
      saveCanvasDocument("offline-owner", "images", "latest-v2")
    ).rejects.toThrow("storage unavailable");
    state.open.mockClear();
    await expect(
      readCanvasDocument("offline-owner", "images")
    ).resolves.toEqual({
      scene: "latest-v2",
      recoveryError: "storage unavailable",
    });
    expect(state.open).not.toHaveBeenCalled();
    const write = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn();
    state.open.mockResolvedValue({ write, close });
    await saveCanvasDocument("offline-owner", "images", "latest-v2");
    expect(write).toHaveBeenCalledWith("latest-v2");
    expect(close).toHaveBeenCalledOnce();
  });
  it("正常恢复与读取失败都会关闭句柄", async () => {
    const close = vi.fn();
    state.open.mockResolvedValue({ read: async () => "saved-v1", close });
    await expect(
      readCanvasDocument("read-owner", "whiteboard")
    ).resolves.toEqual({ scene: "saved-v1", recoveryError: "" });
    expect(close).toHaveBeenCalledOnce();
    state.open.mockResolvedValue({
      read: async () => {
        throw new Error("read failure");
      },
      close,
    });
    await expect(readCanvasDocument("read-owner-2", "images")).rejects.toThrow(
      "read failure"
    );
    expect(close).toHaveBeenCalledTimes(2);
  });
});
