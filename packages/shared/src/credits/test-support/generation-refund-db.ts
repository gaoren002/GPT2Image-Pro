/** 退款测试驱动：真实 Drizzle SQL，受控提交/回滚，不连接 PostgreSQL。 */
import { drizzle, type NodePgClient } from "drizzle-orm/node-postgres";

type Row = Record<string, unknown>;
type Query = { text: string; rowMode?: string };

/** 无定时器的可控调度门。 */
function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** 内存提交日志：所有 SQL 来自真实 Drizzle，未知 SQL 必须失败，不能默默返回空行。 */
export class ControlledLedger {
  rows: Row[] = [];
  outbox: Row[] = [];
  failOutboxInsert = false;
  failOutboxAck = false;
  failKeyUpdate = false;
  failCommitResponse = false;
  generations: Row[] = [];
  failedScanSnapshot: Row[] | null = null;
  keys = new Map<string, Row>();
  wallet = 100;
  pool = 100;
  queries: Array<{ client: number; text: string; values: unknown[] }> = [];
  held = new Map<string, { owner: number; done: ReturnType<typeof gate> }>();
  nextClient = 0;
  inTransactions = 0;
  failWalletUpdate = false;

  /** 使用独立驱动会话运行真实 Drizzle transaction，禁止嵌套。 */
  database() {
    const global = drizzle(this.client(0) as unknown as NodePgClient);
    return new Proxy(global, {
      get: (target, key) => {
        if (key === "transaction")
          return async (
            run: Parameters<typeof global.transaction>[0],
            config?: Parameters<typeof global.transaction>[1]
          ) => {
            const adapter = drizzle(
              this.client(++this.nextClient) as unknown as NodePgClient
            );
            return adapter.transaction(run, config);
          };
        const value: unknown = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  /** 预置权威消费/退款流水，调用方 metadata 不参与这部分数据。 */
  debit(amount: number, keyId?: string, generationId = "g1", userId = "u1") {
    this.rows.push({
      id: `debit-${this.rows.length}`,
      user_id: userId,
      type: "consumption",
      amount,
      source_ref: `${generationId}:charge-${this.rows.length}`,
      metadata: { generationId, ...(keyId ? { externalApiKeyId: keyId } : {}) },
    });
  }

  /** 模拟 PostgreSQL 两位 numeric。 */
  numeric(value: number) {
    return Math.round((value + Number.EPSILON) * 100) / 100;
  }

  /** 列投影由 Drizzle 生成的 SELECT/RETURNING 决定，保留驱动的 array rowMode 契约。 */
  response(text: string, config: Query, rows: Row[], values: unknown[]) {
    const projection =
      /^select (.*?) from /i.exec(text)?.[1] ??
      / returning (.*)$/i.exec(text)?.[1];
    if (config.rowMode !== "array" || !projection)
      return { rows, rowCount: rows.length };
    const columns = projection.split(", ").map((part) => {
      const field = /"([a-z_]+)"$/.exec(part)?.[1];
      if (!field)
        throw new Error(
          `Unsupported projection: ${part}; params=${values.length}`
        );
      return field;
    });
    return {
      rows: rows.map((row) => columns.map((field) => row[field] ?? null)),
      rowCount: rows.length,
    };
  }

  /** 每个会话的写入仅在 COMMIT 时发布，ROLLBACK 完整丢弃；锁持有到事务结束。 */
  client(id: number) {
    let active = false;
    let walletDelta = 0;
    let poolDelta = 0;
    const added: Row[] = [];
    const keyChanges = new Map<string, number>();
    const releaseLocks = () => {
      for (const [key, lock] of this.held)
        if (lock.owner === id) {
          this.held.delete(key);
          lock.done.release();
        }
    };
    const lock = async (key: string) => {
      if (!active) throw new Error("Lock outside transaction");
      while (this.held.has(key) && this.held.get(key)?.owner !== id)
        await this.held.get(key)?.done.promise;
      if (!this.held.has(key)) this.held.set(key, { owner: id, done: gate() });
    };
    return {
      query: async (config: Query, values: unknown[] = []) => {
        const text = config.text;
        this.queries.push({ client: id, text, values });
        if (text.startsWith("begin")) {
          if (active) throw new Error("Nested transaction");
          active = true;
          this.inTransactions += 1;
          return { rows: [] };
        }
        if (text === "commit" || text === "rollback") {
          if (!active) throw new Error("No transaction");
          if (text === "commit") {
            this.rows.push(...added);
            this.wallet = this.numeric(this.wallet + walletDelta);
            this.pool = this.numeric(this.pool + poolDelta);
            for (const [key, delta] of keyChanges) {
              const row = this.keys.get(key);
              if (row)
                row.credits_used = this.numeric(
                  Number(row.credits_used) + delta
                );
            }
          }
          active = false;
          this.inTransactions -= 1;
          releaseLocks();
          if (text === "commit" && this.failCommitResponse) {
            this.failCommitResponse = false;
            throw new Error("Commit response lost");
          }
          return { rows: [] };
        }
        if (text.includes("pg_advisory_xact_lock")) {
          await lock(`generation:${String(values[0])}`);
          return { rows: [] };
        }
        if (text.startsWith('insert into "generation_refund_outbox"')) {
          if (this.failOutboxInsert) throw new Error("Outbox unavailable");
          const match = /\((.*?)\) values \((.*?)\)/.exec(text);
          if (!match?.[1] || !match[2])
            throw new Error("Unrecognized outbox insert");
          const columns = match[1]
            .split(", ")
            .map((column) => column.replaceAll('"', ""));
          const fields = match[2].split(", ");
          const row: Row = {
            state: "pending",
            attempts: 0,
            next_attempt_at: new Date().toISOString(),
            created_at: new Date().toISOString(),
            settled_at: null,
          };
          columns.forEach((column, index) => {
            const token = fields[index];
            if (token?.startsWith("$"))
              row[column] = values[Number(token.slice(1)) - 1];
          });
          if (
            this.outbox.some(
              (item) =>
                item.user_id === row.user_id &&
                item.source_ref === row.source_ref
            )
          )
            return this.response(text, config, [], values);
          this.outbox.push(row);
          return this.response(text, config, [row], values);
        }
        if (
          text.startsWith("select ") &&
          text.split(" from ")[1]?.startsWith('"generation_refund_outbox"')
        ) {
          const rows = text.includes('"source_ref" =')
            ? this.outbox.filter(
                (row) =>
                  row.user_id === values[0] && row.source_ref === values[1]
              )
            : this.outbox.filter(
                (row) =>
                  row.state === "pending" &&
                  String(row.next_attempt_at) <= String(values[1])
              );
          return this.response(text, config, rows, values);
        }
        if (text.startsWith('update "generation_refund_outbox"')) {
          const where = text.split(" where ")[1] ?? "";
          const parameter = /"id" = \$(\d+)/.exec(where)?.[1];
          const row = this.outbox.find(
            (item) => item.id === values[Number(parameter) - 1]
          );
          const attempts = /"attempts" = \$(\d+)/.exec(where)?.[1];
          const due = /"next_attempt_at" <= \$(\d+)/.exec(where)?.[1];
          if (
            row?.state !== "pending" ||
            (attempts && row.attempts !== values[Number(attempts) - 1]) ||
            (due &&
              String(row.next_attempt_at) > String(values[Number(due) - 1]))
          )
            return this.response(text, config, [], values);
          const state = /set "state" = \$(\d+)/.exec(text)?.[1];
          if (state && this.failOutboxAck) throw new Error("Ack unavailable");
          for (const column of ["state", "settled_at", "next_attempt_at"]) {
            const token = new RegExp(`"${column}" = \\$(\\d+)`).exec(
              text.split(" where ")[0] ?? ""
            )?.[1];
            if (token) row[column] = values[Number(token) - 1];
          }
          if (text.includes('"attempts" + 1'))
            row.attempts = Number(row.attempts) + 1;
          return this.response(text, config, [row], values);
        }
        if (text.startsWith("select ") && text.includes('from "generation"')) {
          const failed = text.includes("NOT EXISTS");
          const terminalRefParameter =
            /"generation_refund_outbox"\."source_ref" = \("generation"\."id" \|\| \$(\d+)\)/.exec(
              text
            )?.[1];
          // timestamp 列与参数按墙上时间比较（PG 把带 Z 的参数转成无时区 timestamp）。
          const createdSinceParameter =
            /"generation"\."created_at" >= \$(\d+)/.exec(text)?.[1];
          const wallClock = (value: unknown) =>
            String(value)
              .replace("T", " ")
              .replace(/(\.\d+)?Z$/, "");
          const createdSince = createdSinceParameter
            ? wallClock(values[Number(createdSinceParameter) - 1])
            : null;
          const rows = (
            failed && this.failedScanSnapshot
              ? this.failedScanSnapshot
              : this.generations
          ).filter((row) =>
            failed
              ? row.status === "failed" &&
                // 快照即 SQL 已返回的结果集，谓词已在“查询”时生效。
                (this.failedScanSnapshot !== null ||
                  ((createdSince === null ||
                    wallClock(row.created_at) >= createdSince) &&
                    !this.outbox.some(
                      (intent) =>
                        intent.user_id === row.user_id &&
                        intent.generation_id === row.id &&
                        (!terminalRefParameter ||
                          intent.source_ref ===
                            `${String(row.id)}${String(values[Number(terminalRefParameter) - 1])}`)
                    )))
              : row.status === "pending"
          );
          if (failed) {
            // JSON 财务投影保留相同数据形状；SQL 的不留私密列另由谓词断言覆盖。
            return {
              rows: rows.map((row) => [
                row.id,
                row.user_id,
                row.credits_consumed,
                {
                  ...(row.metadata as Row),
                  targetCredits:
                    ((row.metadata as Row)?.timeout as Row)?.targetCredits ??
                    ((row.metadata as Row)?.settlement as Row)?.targetCredits,
                },
              ]),
              rowCount: rows.length,
            };
          }
          return this.response(text, config, rows, values);
        }
        if (text.startsWith('update "generation"')) {
          const where = text.split(" where ")[1] ?? "";
          const idParameter = /"id" = \$(\d+)/.exec(where)?.[1];
          const row = this.generations.find(
            (item) => item.id === values[Number(idParameter) - 1]
          );
          const expectedStatusParameter = /"status" = \$(\d+)/.exec(where)?.[1];
          if (
            !row ||
            (expectedStatusParameter &&
              row.status !== values[Number(expectedStatusParameter) - 1])
          )
            return this.response(text, config, [], values);
          if (text.includes("LEAST("))
            row.credits_consumed = Math.min(
              Number(row.credits_consumed),
              Number(values[0])
            );
          for (const field of ["status", "credits_consumed"]) {
            const parameter = new RegExp(`"${field}" = \\$(\\d+)`).exec(
              text
            )?.[1];
            if (parameter)
              row[field] =
                field === "credits_consumed"
                  ? Number(values[Number(parameter) - 1])
                  : values[Number(parameter) - 1];
          }
          const metadata = values.find(
            (value) =>
              typeof value === "string" &&
              value.startsWith("{") &&
              value.includes("timeout")
          );
          if (typeof metadata === "string")
            row.metadata = {
              ...(row.metadata as Row),
              ...JSON.parse(metadata),
            };
          return this.response(text, config, [row], values);
        }
        if (
          text.startsWith("select ") &&
          text.includes('from "credits_transaction"')
        ) {
          const userId = values[0];
          let rows = this.rows.filter((row) => row.user_id === userId);
          if (text.includes("->> 'generationId'")) {
            const generationParameter = /->> 'generationId' = \$(\d+)/.exec(
              text
            )?.[1];
            const generationId = values[Number(generationParameter) - 1];
            const sourceRef = values.find(
              (value) => typeof value === "string" && value.includes(":")
            );
            rows = rows.filter(
              (row) =>
                (row.metadata as Row)?.generationId === generationId ||
                (row.type === "refund" && row.source_ref === sourceRef)
            );
          } else {
            rows = rows.filter(
              (row) => row.type === values[1] && row.source_ref === values[2]
            );
          }
          return this.response(text, config, rows, values);
        }
        if (
          text.startsWith("select ") &&
          text.includes('from "credits_balance"')
        ) {
          return this.response(
            text,
            config,
            [
              {
                id: "wallet",
                user_id: "u1",
                balance: this.wallet,
                total_earned: 100,
                total_spent: 0,
                status: "active",
                created_at: "2026-10-24",
                updated_at: "2026-10-24",
              },
            ],
            values
          );
        }
        if (
          text.startsWith("select ") &&
          text.includes('from "credits_batch"')
        ) {
          if (text.endsWith("for update")) await lock("pool:u1");
          return this.response(text, config, [{ id: "refund-pool" }], values);
        }
        if (
          text.startsWith("select ") &&
          text.includes('from "external_api_key"')
        ) {
          const keyId = String(values[0]);
          if (text.endsWith("for update")) await lock(`key:${keyId}`);
          const row = this.keys.get(keyId);
          return this.response(
            text,
            config,
            row && row.user_id === values[1] ? [row] : [],
            values
          );
        }
        if (text.startsWith('insert into "credits_transaction"')) {
          const match = /\((.*?)\) values \((.*?)\)/.exec(text);
          if (!match?.[1] || !match[2])
            throw new Error("Unrecognized transaction insert");
          const columns = match[1]
            .split(", ")
            .map((column) => column.replaceAll('"', ""));
          const fields = match[2].split(", ");
          const row = Object.fromEntries(
            columns.map((column, index) => {
              const token = fields[index] ?? "default";
              const value = token.startsWith("$")
                ? values[Number(token.slice(1)) - 1]
                : null;
              return [
                column,
                column === "metadata" && typeof value === "string"
                  ? JSON.parse(value)
                  : value,
              ];
            })
          );
          if (
            this.rows.some(
              (existing) =>
                existing.user_id === row.user_id &&
                existing.type === row.type &&
                existing.source_ref === row.source_ref
            )
          )
            throw new Error("unique constraint violation");
          added.push(row);
          return this.response(text, config, [row], values);
        }
        if (text.startsWith('update "credits_batch"')) {
          poolDelta += Number(values[0]);
          return { rows: [] };
        }
        if (text.startsWith('update "external_api_key"')) {
          if (this.failKeyUpdate) throw new Error("Key update failed");
          const parameter = /"id" = \$(\d+)/.exec(text)?.[1];
          const keyId = String(values[Number(parameter) - 1]);
          keyChanges.set(
            keyId,
            (keyChanges.get(keyId) ?? 0) - Number(values[0])
          );
          return { rows: [] };
        }
        if (text.startsWith('update "credits_balance"')) {
          if (this.failWalletUpdate)
            throw new Error("Injected wallet update failure");
          walletDelta += Number(values[0]);
          return { rows: [] };
        }
        throw new Error(`Unhandled SQL: ${text}`);
      },
    };
  }
}
