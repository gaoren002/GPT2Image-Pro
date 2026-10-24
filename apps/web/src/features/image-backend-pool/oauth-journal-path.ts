/** RT日志根目录解析：与local provider一致展开运行进程HOME；根目录必须已部署，禁止相对release路径。 */
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { getRuntimeSettingString } from "@repo/shared/system-settings";
import { OAuthRecoveryError } from "./oauth-rotation-types";

/** 不读取代理机器的路径；默认homedir来自实际运行进程，测试可注入目标HOME。 */
export function expandOAuthStoragePath(configured: string, home = homedir()) {
  const value = configured.trim();
  const expanded =
    value === "~" || value.startsWith("~/")
      ? join(home, value.slice(2))
      : value;
  if (!expanded || !isAbsolute(expanded))
    throw new OAuthRecoveryError("storage-path-must-be-absolute", false);
  return expanded;
}

/** 专用ENV override > 运行时LOCAL_STORAGE_PATH(DB优先、ENV后备)；没有cwd默认目录。 */
export async function resolveOAuthJournalRoot() {
  try {
    const override = process.env.IMAGE_BACKEND_RT_JOURNAL_ROOT?.trim();
    const configured =
      override ||
      (await getRuntimeSettingString("LOCAL_STORAGE_PATH")) ||
      process.env.LOCAL_STORAGE_PATH;
    if (!configured) throw new OAuthRecoveryError("storage-missing", false);
    const root = await realpath(expandOAuthStoragePath(configured));
    if (!(await stat(root)).isDirectory())
      throw new OAuthRecoveryError("storage-root-not-directory", false);
    return root;
  } catch {
    throw new OAuthRecoveryError("storage-not-deployed", false);
  }
}
