/** 可编辑文件断连恢复客户端：只查询既有任务、不重发POST；保留上传引用确认。 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  editableFileTaskQueryUrl,
  readRecoverableEditableFileResponse,
} from "./editable-file-recovery-client";
afterEach(() => vi.unstubAllGlobals());
describe("editable client recovery", () => {
  it("连接失败凭提交前已知ID查询已付产物，重新取得URL", async () => {
    const submit = vi.fn().mockRejectedValue(new Error("disconnected"));
    const fetch = vi.fn().mockResolvedValue(
      Response.json({
        status: "completed",
        creditsCharged: 28,
        result: { primaryUrl: "fresh", zipUrl: null },
      })
    );
    vi.stubGlobal("fetch", fetch);
    expect(
      await readRecoverableEditableFileResponse(
        submit,
        { taskId: "message-1", kind: "ppt" },
        vi.fn()
      )
    ).toEqual({
      result: { primary_url: "fresh", zip_url: null },
      credits_charged: 28,
    });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      "/api/editable-file/tasks/message-1?kind=ppt",
      { cache: "no-store" }
    );
  });
  it("生成错误先保存附件确认，再查询恢复结果", async () => {
    const receive = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          status: "completed",
          creditsCharged: 25,
          result: { primaryUrl: "fresh", zipUrl: "zip" },
        })
      )
    );
    const data = {
      error: { message: "delivery failed" },
      sourceImageReferences: { messageId: "m" },
    };
    await readRecoverableEditableFileResponse(
      async () => Response.json(data),
      { taskId: "m", kind: "psd" },
      receive
    );
    expect(receive).toHaveBeenCalledWith(data);
  });
  it.each([
    "prepared",
    "running",
    "refund_pending",
    "refunded",
    "failed",
  ])("%s只查询一次且保留原错误，禁止再次POST", async (status) => {
    const submit = vi.fn().mockRejectedValue(new Error("lost"));
    const fetch = vi
      .fn()
      .mockResolvedValue(Response.json({ status, result: null }));
    vi.stubGlobal("fetch", fetch);
    await expect(
      readRecoverableEditableFileResponse(
        submit,
        { taskId: "m", kind: "ppt" },
        vi.fn()
      )
    ).rejects.toThrow("lost");
    expect(submit).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("成功直接返回，不做额外网络或后扣费", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const result = await readRecoverableEditableFileResponse(
      async () =>
        Response.json({ result: { primary_url: "url" }, credits_charged: 25 }),
      { taskId: "m", kind: "ppt" },
      vi.fn()
    );
    expect(result.credits_charged).toBe(25);
    expect(fetch).not.toHaveBeenCalled();
    expect(editableFileTaskQueryUrl("m/a", "psd")).toBe(
      "/api/editable-file/tasks/m%2Fa?kind=psd"
    );
  });
});
