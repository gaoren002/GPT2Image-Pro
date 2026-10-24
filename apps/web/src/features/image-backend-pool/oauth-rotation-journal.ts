/** 私有 AES-GCM 轮换日志；复用既有持久 app-storage 卷，先 fsync 密文再做数据库落库。 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  mkdir,
  link,
  lstat,
  open,
  rename,
  readdir,
  readFile,
  realpath,
  stat,
  unlink,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { logWarn } from "@repo/shared/logger";
import { z } from "zod";
import {
  OAuthRecoveryError,
  oauthCheckpointRef,
  type OAuthRotationPlan,
} from "./oauth-rotation-types";
import { expandOAuthStoragePath } from "./oauth-journal-path";
import { oauthRotationKey } from "./oauth-identity";

const targetSchema = z
  .object({
    id: z.string().min(1).optional(),
    name: z.string().min(1),
    implementationMode: z.enum(["web", "responses"]),
    groupId: z.string().min(1).nullable().optional(),
    groupIds: z.array(z.string().min(1)).nullable().optional(),
    mergeGroupIds: z.boolean().optional(),
    email: z.string().nullable().optional(),
    model: z.string().nullable().optional(),
    qualityBilling: z.record(z.string(), z.number()).nullable().optional(),
    contentSafetyEnabled: z.boolean(),
    isEnabled: z.boolean(),
    alwaysActive: z.boolean().optional(),
    priority: z.number().int().min(0).max(10000),
    concurrency: z.number().int().min(1).max(100),
    status: z.string().optional(),
    cooldownUntil: z
      .union([z.date(), z.string().datetime({ offset: true })])
      .nullable()
      .optional(),
    lastError: z.string().nullable().optional(),
    lastErrorAt: z
      .union([z.date(), z.string().datetime({ offset: true })])
      .nullable()
      .optional(),
    metadata: z.record(z.string(), z.unknown()).nullable().optional(),
    expectedCredentialHash: z.string().min(1).optional(),
  })
  .passthrough();
const targetsSchema = z.array(targetSchema).min(1).max(2);
const planSchema = z.object({
  version: z.literal(1),
  id: z.string().regex(/^[a-f0-9]{64}$/),
  owner: z.string().uuid(),
  journalIdentity: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  clientId: z.string().min(1),
  accessToken: z.string(),
  idToken: z.string().optional(),
  refreshToken: z.string().min(1),
  rotated: z.boolean(),
  targets: targetsSchema,
});

const refPattern =
  /^[a-f0-9]{64}\.[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
// 发布临时文件只存在于一次 fsync+link 之间；超过该年龄的残留来自崩溃，可安全回收。
const TEMP_RESIDUE_MAX_AGE_MS = 60 * 60 * 1000;
/** 只比较固定错误码，不传播文件系统路径或原始异常。 */
function hasCode(error: unknown, code: string) {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === code
  );
}
/** 配置、卷标识、文件I/O均在数据库事务外；无临时目录降级。 */
export function oauthJournal(storageRoot = process.env.LOCAL_STORAGE_PATH) {
  const secret = process.env.BETTER_AUTH_SECRET;
  const base = storageRoot ? expandOAuthStoragePath(storageRoot) : "";
  if (!secret || secret.length < 32 || !base)
    throw new OAuthRecoveryError("configuration", false);
  const key = createHash("sha256")
    .update(`pool-oauth-rotation:v1:${secret}`)
    .digest();
  const directory = join(resolve(base), ".private", "pool-oauth-rotation");
  const fingerprint = createHash("sha256").update(key).digest("hex");
  /** 只接受 owner 限定引用；不存在按操作 id 命名的共享路径，同 id 不同 owner 不会互相覆盖。 */
  const file = (ref: string) => {
    if (refPattern.test(ref)) return join(directory, `${ref}.checkpoint`);
    throw new OAuthRecoveryError("invalid-id", false);
  };
  /** rename/link/unlink后同步目录项，不能把页缓存确认当作耐久凭证。 */
  async function syncDirectory() {
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  /** 普通文件0600；损坏/权限错误保持fail closed。 */
  async function readPath(path: string) {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
      throw 0;
    return readFile(path, "utf8");
  }
  /** 先完整fsync临时文件，再原子发布；immutable使用link的no-replace语义。 */
  async function publish(path: string, value: string, immutable = false) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(value, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (immutable) await link(temporary, path);
      else await rename(temporary, path);
      await syncDirectory();
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }
  /** 并发初始化不暴露半写marker；existing值永不覆盖。 */
  async function marker(name: string, initial: string) {
    const path = join(directory, name);
    try {
      await publish(path, initial, true);
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
    }
    // 即使另一进程尚未同步link目录项，本实例也在返回身份前确认目录耐久。
    const value = await readPath(path);
    await syncDirectory();
    return value;
  }
  /** 卷UUID避免相同路径下换空卷或非共享卷被认成同一配置。 */
  async function binding() {
    const canonical = await realpath(base);
    if (!(await stat(canonical)).isDirectory())
      throw new OAuthRecoveryError("storage-not-deployed", false);
    for (const path of [join(resolve(base), ".private"), directory]) {
      await mkdir(path, { recursive: true, mode: 0o700 });
      const info = await lstat(path);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        (info.mode & 0o077) !== 0
      )
        throw new OAuthRecoveryError("storage-permissions", false);
      const parent = await open(dirname(path), "r");
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    }
    if ((await marker("key-version-1", fingerprint)) !== fingerprint)
      throw new OAuthRecoveryError("key-version-mismatch", false);
    const volume = await marker("volume-version-1", randomUUID());
    if (!z.string().uuid().safeParse(volume).success)
      throw new OAuthRecoveryError("volume-version-mismatch", false);
    return createHash("sha256")
      .update(JSON.stringify(["journal:v1", canonical, volume, fingerprint]))
      .digest("hex");
  }
  /** AES-GCM同时绑定操作、owner与用途；不同owner的密文不能互换引用。 */
  function seal(plan: OAuthRotationPlan) {
    const purpose = "checkpoint";
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(`${oauthCheckpointRef(plan)}:${purpose}`));
    const body = Buffer.concat([
      cipher.update(JSON.stringify(plan), "utf8"),
      cipher.final(),
    ]);
    return JSON.stringify({
      v: 2,
      owner: plan.owner,
      purpose,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      body: body.toString("base64"),
    });
  }
  /** 只接受v2 owner checkpoint；引用、owner、用途任一不符都按损坏处理，文件保留作证据。 */
  function decode(ref: string, encrypted: string) {
    try {
      if (!refPattern.test(ref)) throw 0;
      const stored = z
        .object({
          v: z.literal(2),
          owner: z.string().uuid(),
          purpose: z.literal("checkpoint"),
          iv: z.string(),
          tag: z.string(),
          body: z.string(),
        })
        .parse(JSON.parse(encrypted));
      const id = ref.split(".")[0] ?? "";
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(stored.iv, "base64")
      );
      decipher.setAAD(Buffer.from(`${id}.${stored.owner}:${stored.purpose}`));
      decipher.setAuthTag(Buffer.from(stored.tag, "base64"));
      const plan = planSchema.parse(
        JSON.parse(
          Buffer.concat([
            decipher.update(Buffer.from(stored.body, "base64")),
            decipher.final(),
          ]).toString("utf8")
        )
      ) as OAuthRotationPlan;
      if (
        plan.id !== id ||
        plan.owner !== stored.owner ||
        oauthCheckpointRef(plan) !== ref
      )
        throw 0;
      return plan;
    } catch {
      throw new OAuthRecoveryError(ref);
    }
  }
  /** owner文件不可覆盖；同owner重试只接受相同计划。 */
  async function write(ref: string, encrypted: string) {
    const plan = decode(ref, encrypted);
    try {
      await publish(file(ref), encrypted, true);
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
      if (
        JSON.stringify(decode(ref, await readPath(file(ref)))) !==
        JSON.stringify(plan)
      )
        throw new OAuthRecoveryError(ref);
      await syncDirectory();
    }
  }
  return {
    /** 消费RT前校验目标及序列化能力。 */
    validateTargets(targets: unknown) {
      try {
        targetsSchema.parse(targets);
        JSON.stringify(targets);
      } catch {
        throw new OAuthRecoveryError("invalid-target", false);
      }
    },
    operationId: oauthRotationKey,
    binding,
    /** 独立probe命名空间；崩溃残留不参与恢复，下次预检清理probe与过期临时文件。 */
    async prepare() {
      const identity = await binding();
      const staleBefore = Date.now() - TEMP_RESIDUE_MAX_AGE_MS;
      for (const name of await readdir(directory)) {
        const path = join(directory, name);
        let residue = /^probe\.[a-f0-9-]{36}\.json$/.test(name);
        if (!residue && name.endsWith(".tmp")) {
          // 只回收早于阈值的临时文件：其他进程正在发布的临时文件不能被误删。
          const info = await lstat(path).catch((error: unknown) => {
            if (hasCode(error, "ENOENT")) return null;
            throw error;
          });
          residue = !!info?.isFile() && info.mtimeMs < staleBefore;
        }
        if (residue)
          await unlink(path).catch((error: unknown) => {
            if (!hasCode(error, "ENOENT")) throw error;
          });
        if (residue && name.endsWith(".tmp"))
          logWarn("Reclaimed stale OAuth journal temporary file", {
            source: "image-backend-pool-oauth-journal",
          });
      }
      const probe = join(directory, `probe.${randomUUID()}.json`);
      await publish(probe, "preflight");
      await unlink(probe).catch((error: unknown) => {
        if (!hasCode(error, "ENOENT")) throw error;
      });
      await syncDirectory();
      return identity;
    },
    encrypt: (plan: OAuthRotationPlan) => seal(plan),
    decrypt: (ref: string, encrypted: string) => decode(ref, encrypted),
    write,
    /** ENOENT才表示不存在，其他错误保留证据。 */
    async read(ref: string) {
      try {
        return await readPath(file(ref));
      } catch (error) {
        if (hasCode(error, "ENOENT")) return null;
        throw new OAuthRecoveryError(ref);
      }
    },
    /** 只列owner checkpoint；探针、临时文件与标记不进入恢复扫描，损坏checkpoint由解密fail closed。 */
    async list() {
      const refs: string[] = [];
      for (const name of await readdir(directory))
        if (name.endsWith(".checkpoint") && refPattern.test(name.slice(0, -11)))
          refs.push(name.slice(0, -11));
      return refs.sort().slice(0, 100);
    },
    /** 只unlink传入的不可复用owner路径，不读owner再删共享路径。 */
    async remove(ref: string) {
      await unlink(file(ref)).catch((error: unknown) => {
        if (!hasCode(error, "ENOENT")) throw error;
      });
      await syncDirectory();
    },
    /**
     * 把被判定为已取代的 checkpoint 改名为不参与扫描的隔离文件，而不是删除。
     * 判定依赖数据库单调；人工删行或回滚可能让有效新 RT 被误判，隔离保留唯一副本，
     * 由运维在 drain 时核对后统一清理或恢复。
     */
    async quarantine(ref: string) {
      const source = file(ref);
      const renamed = await rename(
        source,
        `${source.slice(0, -".checkpoint".length)}.superseded`
      ).then(
        () => true,
        (error: unknown) => {
          if (hasCode(error, "ENOENT")) return false;
          throw error;
        }
      );
      await syncDirectory();
      // 只有本次真正改名才返回 true；另一实例已隔离或文件只存在于 DB 时返回 false。
      return renamed;
    },
  };
}
