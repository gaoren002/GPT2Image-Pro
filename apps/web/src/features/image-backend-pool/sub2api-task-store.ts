/**
 * Sub2API 任务设置的权威读与原子读改写，供池配置和同步结果使用。
 * 复用 system_setting 主键行锁，不经 runtime 默认值/实例缓存；锁内只做本地 JSON 修改。
 */
import { db } from "@repo/database";
import { systemSetting } from "@repo/database/schema";
import { clearSystemSettingsCache } from "@repo/shared/system-settings";
import { eq } from "drizzle-orm";
const TASK_KEY = "SUB2API_AUTO_SYNC_TASKS";

/** 已存值损坏时中止，不能把解析失败或非法记录变为空数组写回。 */
function parseTasks<T>(
  value: unknown,
  normalize: (item: unknown) => T | null
): T[] {
  // 兼容系统设置编辑器早期写入的 JSON 字符串；非法 JSON 仍必须中止。
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      throw new Error("自动同步任务配置损坏，已中止写入");
    }
  }
  const items = Array.isArray(value)
    ? value
    : value && typeof value === "object" && "tasks" in value
      ? value.tasks
      : undefined;
  if (!Array.isArray(items))
    throw new Error("自动同步任务配置损坏，已中止写入");
  return items.map((item) => {
    const task = normalize(item);
    if (!task) throw new Error("自动同步任务配置损坏，已中止写入");
    return task;
  });
}

/** 直接读库；不存在才是空任务，读失败直接上抛，不使用设置缓存。 */
export async function readSub2ApiTaskSetting<T>(
  normalize: (item: unknown) => T | null
): Promise<T[]> {
  const [row] = await db
    .select({ value: systemSetting.value })
    .from(systemSetting)
    .where(eq(systemSetting.key, TASK_KEY))
    .limit(1);
  return row ? parseTasks(row.value, normalize) : [];
}

/**
 * 缺行先幂等创建，再 FOR UPDATE；首建竞争也在同一主键上串行。
 * 事务失败整体回滚；回调同步执行且只能改当前权威 JSON，不得在锁内访问上游。
 */
export async function mutateSub2ApiTaskSetting<T, R>(
  normalize: (item: unknown) => T | null,
  change: (tasks: T[]) => { tasks: T[]; result: R }
): Promise<R> {
  const result = await db.transaction(async (tx) => {
    await tx
      .insert(systemSetting)
      .values({ key: TASK_KEY, value: [], isSecret: false })
      .onConflictDoNothing({ target: systemSetting.key });
    const [row] = await tx
      .select({ value: systemSetting.value })
      .from(systemSetting)
      .where(eq(systemSetting.key, TASK_KEY))
      .for("update");
    if (!row) throw new Error("自动同步任务配置读取失败");
    const changed = change(parseTasks(row.value, normalize));
    await tx
      .update(systemSetting)
      .set({ value: changed.tasks, isSecret: false, updatedAt: new Date() })
      .where(eq(systemSetting.key, TASK_KEY));
    return changed.result;
  });
  clearSystemSettingsCache();
  return result;
}
