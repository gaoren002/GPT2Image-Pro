/** 消费测试专用驱动：执行真实 Drizzle SQL，模拟行锁/唯一键/提交回滚，不连接 PostgreSQL。 */
import { drizzle, type NodePgClient } from "drizzle-orm/node-postgres";

type Row = Record<string, unknown>;
type Query = { text: string; rowMode?: string };
type Table = "credits_batch" | "external_api_key" | "credits_balance";

/** 一次性调度门，不依赖 sleep 或轮询。 */
export function consumptionGate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** 两位 numeric 的存储精度。 */
function numeric(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** 只执行生产 SQL 中实际存在的 WHERE 条件，不为缺失的安全谓词补判断。 */
function matches(row: Row, where: string, values: unknown[]) {
  const basicWhere = where.replace(
    /"external_api_key"\."credit_limit" - "external_api_key"\."credits_used" >= \$\d+/g,
    ""
  );
  for (const [, field, operator, parameter] of basicWhere.matchAll(
    /"([a-z_]+)" (=|>=|>|<) \$(\d+)/g
  )) {
    const value = values[Number(parameter) - 1];
    const current = row[field ?? ""];
    if (operator === "=") {
      if (current !== value) return false;
    } else {
      if (current == null) {
        if (field === "expires_at" && where.includes('"expires_at" is null'))
          continue;
        return false;
      }
      const left =
        field === "expires_at"
          ? new Date(String(current)).getTime()
          : Number(current);
      const right =
        field === "expires_at"
          ? new Date(String(value)).getTime()
          : Number(value);
      if (
        operator === ">="
          ? left < right
          : operator === ">"
            ? left <= right
            : left >= right
      )
        return false;
    }
  }
  const quota = /"credit_limit" - .*?"credits_used"\)? >= \$(\d+)/.exec(
    where
  )?.[1];
  if (
    quota &&
    row.credit_limit != null &&
    Number(row.credit_limit) - Number(row.credits_used) <
      Number(values[Number(quota) - 1])
  )
    return false;
  return true;
}

/** 受控数据库：每个真实 Drizzle transaction 使用独立驱动会话，写集仅在 COMMIT 发布。 */
export class ConsumptionDatabase {
  batches = new Map<string, Row>();
  keys = new Map<string, Row>();
  wallets = new Map<string, Row>();
  entries: Row[] = [];
  queries: Array<{ client: number; text: string; values: unknown[] }> = [];
  locks = new Map<
    string,
    { owner: number; done: ReturnType<typeof consumptionGate> }
  >();
  nextClient = 0;
  activeTransactions = 0;
  peakTransactions = 0;
  failWallet = false;
  rejectWallet = false;
  failInsert = false;
  beforeKeyUpdate: (() => Promise<void>) | undefined;

  /** 默认钱包/批次 1000，Key 限额 100；可由测试修改权威行模拟管理员操作。 */
  constructor() {
    this.wallets.set("u1", {
      id: "wallet-1",
      user_id: "u1",
      balance: 1000,
      total_spent: 0,
      status: "active",
    });
    this.batches.set("b1", {
      id: "b1",
      user_id: "u1",
      amount: 1000,
      remaining: 1000,
      status: "active",
      source_type: "purchase",
      issued_at: "2026-10-01",
      expires_at: null,
    });
    this.keys.set("k1", {
      id: "k1",
      user_id: "u1",
      is_active: true,
      credit_limit: 100,
      credits_used: 0,
    });
  }

  /** 只代理最外层 transaction；嵌套会发出 savepoint，驱动显式拒绝。 */
  database() {
    const global = drizzle(this.client(0) as unknown as NodePgClient);
    return new Proxy(global, {
      get: (target, key) => {
        if (key === "transaction")
          return async (
            run: Parameters<typeof global.transaction>[0],
            config?: Parameters<typeof global.transaction>[1]
          ) =>
            drizzle(
              this.client(++this.nextClient) as unknown as NodePgClient
            ).transaction(run, config);
        const value: unknown = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  /** 模拟 pg array rowMode；列顺序来自真实 Drizzle 投影，日期/JSON 仍走真实列解码。 */
  response(config: Query, rows: Row[]) {
    const projection =
      /^select (.*?) from /i.exec(config.text)?.[1] ??
      / returning (.*)$/i.exec(config.text)?.[1];
    if (config.rowMode !== "array" || !projection)
      return { rows, rowCount: rows.length };
    const fields = projection.split(", ").map((part) => {
      const field = /"([a-z_]+)"$/.exec(part)?.[1];
      if (!field) throw new Error(`Unsupported projection: ${part}`);
      return field;
    });
    return {
      rows: rows.map((row) => fields.map((field) => row[field] ?? null)),
      rowCount: rows.length,
    };
  }

  /** 行锁持有至事务结束；等锁后重读已提交版本并重新检查 SQL 谓词。 */
  client(id: number) {
    let active = false;
    const writes = new Map<Table, Map<string, Row>>();
    const entries: Row[] = [];
    const table = (name: Table) =>
      name === "credits_batch"
        ? this.batches
        : name === "external_api_key"
          ? this.keys
          : this.wallets;
    const rows = (name: Table) =>
      new Map([
        ...table(name),
        ...(writes.get(name) ?? new Map<string, Row>()),
      ]);
    const write = (name: Table, key: string, row: Row) => {
      if (!active) throw new Error("Write outside transaction");
      if (!writes.has(name)) writes.set(name, new Map());
      writes.get(name)?.set(key, row);
    };
    const lock = async (key: string) => {
      if (!active) throw new Error("Lock outside transaction");
      while (this.locks.has(key) && this.locks.get(key)?.owner !== id)
        await this.locks.get(key)?.done.promise;
      if (!this.locks.has(key))
        this.locks.set(key, { owner: id, done: consumptionGate() });
    };
    const unlock = () => {
      for (const [key, holder] of this.locks)
        if (holder.owner === id) {
          this.locks.delete(key);
          holder.done.release();
        }
    };
    return {
      query: async (config: Query, values: unknown[] = []) => {
        const text = config.text;
        this.queries.push({ client: id, text, values });
        if (text.startsWith("begin")) {
          if (active) throw new Error("Nested transaction");
          active = true;
          this.activeTransactions++;
          this.peakTransactions = Math.max(
            this.peakTransactions,
            this.activeTransactions
          );
          return { rows: [] };
        }
        if (text === "commit" || text === "rollback") {
          if (!active) throw new Error("Transaction already finished");
          if (text === "commit") {
            for (const [name, changes] of writes)
              for (const [key, row] of changes) table(name).set(key, row);
            this.entries.push(...entries);
          }
          active = false;
          this.activeTransactions--;
          unlock();
          return { rows: [] };
        }
        if (text.includes("savepoint")) throw new Error("Nested transaction");
        const where =
          text
            .split(" where ")[1]
            ?.split(/ order by | limit | for update/)[0] ?? "";
        if (text.startsWith("select ")) {
          const name = / from "([a-z_]+)"/.exec(text)?.[1];
          if (name === "credits_transaction")
            return this.response(
              config,
              [...this.entries, ...entries].filter((row) =>
                matches(row, where, values)
              )
            );
          if (
            name !== "credits_batch" &&
            name !== "credits_balance" &&
            name !== "external_api_key"
          )
            throw new Error(`Unexpected SELECT: ${text}`);
          let found = Array.from(rows(name).values()).filter((row) =>
            matches(row, where, values)
          );
          if (text.includes(" limit ")) found = found.slice(0, 1);
          return this.response(config, found);
        }
        if (text.startsWith('insert into "credits_transaction"')) {
          if (this.failInsert)
            throw new Error("Injected ledger insert failure");
          const match = /\((.*?)\) values \((.*?)\)/.exec(text);
          if (!match?.[1] || !match[2]) throw new Error("Unexpected INSERT");
          const fields = match[2].split(", ");
          const row = Object.fromEntries(
            match[1].split(", ").map((field, index) => {
              const column = field.replaceAll('"', "");
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
          if (row.source_ref != null) {
            await lock(
              `unique:${JSON.stringify([row.user_id, row.type, row.source_ref])}`
            );
            if (
              this.entries.some(
                (entry) =>
                  entry.user_id === row.user_id &&
                  entry.type === row.type &&
                  entry.source_ref === row.source_ref
              )
            )
              throw Object.assign(new Error("duplicate consumption"), {
                code: "23505",
              });
          }
          entries.push(row);
          return this.response(config, [row]);
        }
        if (text.startsWith("update ")) {
          const name = /^update "([a-z_]+)"/.exec(text)?.[1];
          if (
            name !== "credits_batch" &&
            name !== "credits_balance" &&
            name !== "external_api_key"
          )
            throw new Error(`Unexpected UPDATE: ${text}`);
          if (name === "external_api_key") await this.beforeKeyUpdate?.();
          const found: Row[] = [];
          for (const [key, previous] of rows(name)) {
            if (!matches(previous, where, values)) continue;
            await lock(`${name}:${key}`);
            const current = rows(name).get(key);
            if (!current || !matches(current, where, values)) continue;
            if (name === "credits_balance" && this.failWallet)
              throw new Error("Injected wallet failure");
            if (name === "credits_balance" && this.rejectWallet) continue;
            const next = { ...current };
            const field =
              name === "credits_batch"
                ? "remaining"
                : name === "external_api_key"
                  ? "credits_used"
                  : "balance";
            const expression = new RegExp(
              `"${field}" = "[a-z_]+"\\."${field}" ([+-]) \\$(\\d+)`
            ).exec(text);
            if (!expression) throw new Error(`Unsupported arithmetic: ${text}`);
            const amount = Number(values[Number(expression[2]) - 1]);
            next[field] = numeric(
              Number(current[field]) +
                (expression[1] === "+" ? amount : -amount)
            );
            if (name === "credits_batch")
              next.status = Number(next.remaining) <= 0 ? "consumed" : "active";
            if (name === "credits_balance")
              next.total_spent = numeric(Number(current.total_spent) + amount);
            write(name, key, next);
            found.push(next);
          }
          return this.response(config, found);
        }
        throw new Error(`Unhandled SQL: ${text}`);
      },
    };
  }
}
