/** 管理员充值 UI 的意图状态；失败重试保留 UUID，表单编辑和成功后结束原意图。 */
type GrantInput = { userId: string; amount: number; reason: string };
type GrantRequest = GrantInput & { requestId: string };

/** 每个表单实例持有一个控制器；同步占位阻止双击，过期回调不能结束后续请求。 */
export function createAdminGrantIntent() {
  let pending: GrantRequest | null = null;
  let inFlight = false;
  return {
    /** 相同失败请求复用 UUID；不同目标、金额或原因开始新意图。 */
    begin(input: GrantInput): GrantRequest | null {
      if (inFlight) return null;
      if (
        !pending ||
        pending.userId !== input.userId ||
        pending.amount !== input.amount ||
        pending.reason !== input.reason
      ) {
        pending = { ...input, requestId: crypto.randomUUID() };
      }
      inFlight = true;
      return { ...pending };
    },
    /** 仅结束匹配的在途请求；网络或服务端错误不销毁其重试身份。 */
    finish(requestId: string, succeeded: boolean) {
      if (!inFlight || pending?.requestId !== requestId) return;
      inFlight = false;
      if (succeeded) pending = null;
    },
    /** 显式新意图或任意表单编辑即作废旧键；在途操作不允许重置。 */
    reset() {
      if (inFlight) return false;
      pending = null;
      return true;
    },
  };
}
