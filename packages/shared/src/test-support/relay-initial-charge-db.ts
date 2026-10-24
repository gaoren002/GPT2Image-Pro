/** 仅测试：复用既有真实 Drizzle 消费/退款驱动，补纯中转财务表的提交写集和 CAS。 */
import { ConsumptionDatabase } from "../credits/test-support/consumption-db";
import { ControlledLedger } from "../credits/test-support/generation-refund-db";

type Row = Record<string, unknown>;
type Query = { text: string; rowMode?: string };
type Result = { rows: unknown[]; rowCount?: number };
type Driver = { query: (query: Query, values?: unknown[]) => Promise<Result> };

/** 驱动仅保存持久标量；时间和故障点由测试控制，未知查询继续由基础驱动拒绝。 */
export class RelayIntentStore {
  rows = new Map<string, Row>();
  now = Date.now();
  failInsert = false;
  failEnqueued = false;
  loseDispatchAck = false;
  loseCaptureAck = false;
  afterSelect: (() => Promise<void>) | undefined;
  afterCaptureCommit: (() => Promise<void>) | undefined;
  queries: Array<{ client: number; text: string; values: unknown[] }> = [];

  /** 真实 SELECT/RETURNING 的 array rowMode 列顺序；所有日期仍由 Drizzle 解码。 */
  response(q: Query, rows: Row[]): Result {
    const projection =
      /^select (.*?) from /i.exec(q.text)?.[1] ??
      / returning (.*)$/i.exec(q.text)?.[1];
    if (q.rowMode !== "array" || !projection)
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

  /** 执行 SQL 实际给出的身份/状态/期限条件；缺失条件会使对应竞争测试失败。 */
  matches(row: Row, where: string, values: unknown[]) {
    for (const [, name, parameter] of where.matchAll(
      /"(id|user_id|generation_id)" = \$(\d+)/g
    )) {
      if (!name) throw new Error("Missing predicate name");
      if (row[name] !== values[Number(parameter) - 1]) return false;
    }
    const states = [...where.matchAll(/"state" = \$(\d+)/g)].map(
      (m) => values[Number(m[1]) - 1]
    );
    if (where.includes(" or ")) {
      if (!states.includes(row.state)) return false;
      if (
        row.state === "captured" &&
        where.includes('"expires_at" <= clock_timestamp()') &&
        new Date(String(row.expires_at)).getTime() > this.now
      )
        return false;
    } else {
      if (states.some((state) => row.state !== state)) return false;
      if (
        where.includes('"expires_at" > clock_timestamp()') &&
        new Date(String(row.expires_at)).getTime() <= this.now
      )
        return false;
    }
    return true;
  }

  /** 每个会话保留新表写集，到基础资金 COMMIT 后同步发布；故障时全部随 ROLLBACK 丢弃。 */
  client<T extends Driver>(base: T, id: number): T {
    let active = false;
    const added: Row[] = [];
    return {
      query: async (q: Query, values: unknown[] = []) => {
        const text = q.text;
        if (text.startsWith("begin")) {
          active = true;
          return base.query(q, values);
        }
        if (text === "commit" || text === "rollback") {
          const result = await base.query(q, values);
          active = false;
          if (text === "commit") {
            for (const row of added) this.rows.set(String(row.id), row);
            if (added.length) await this.afterCaptureCommit?.();
            if (added.length && this.loseCaptureAck) {
              this.loseCaptureAck = false;
              throw new Error("Controlled committed capture ACK loss");
            }
          }
          return result;
        }
        if (text.startsWith('insert into "relay_initial_charge"')) {
          this.queries.push({ client: id, text, values });
          if (!active) throw new Error("Capture intent outside transaction");
          if (this.failInsert)
            throw new Error("Controlled capture intent failure");
          const match = /\((.*?)\) values \((.*?)\)/.exec(text);
          if (!match?.[1] || !match[2])
            throw new Error("Unexpected capture INSERT");
          const fields = match[2].split(", ");
          const row: Row = {
            state: "captured",
            created_at: new Date(this.now).toISOString(),
            updated_at: new Date(this.now).toISOString(),
          };
          match[1].split(", ").forEach((field, index) => {
            const token = fields[index];
            if (token?.startsWith("$"))
              row[field.replaceAll('"', "")] =
                values[Number(token.slice(1)) - 1];
          });
          if (
            [...this.rows.values()].some(
              (existing) =>
                existing.id === row.id ||
                (existing.user_id === row.user_id &&
                  existing.generation_id === row.generation_id)
            )
          )
            throw Object.assign(new Error("duplicate capture intent"), {
              code: "23505",
            });
          added.push(row);
          return this.response(q, [row]);
        }
        if (
          text.includes('from "relay_initial_charge"') ||
          text.startsWith('update "relay_initial_charge"')
        ) {
          this.queries.push({ client: id, text, values });
          const where =
            text
              .split(" where ")[1]
              ?.split(/ order by | limit | returning /)[0] ?? "";
          const rows = [...this.rows.values()].filter((row) =>
            this.matches(row, where, values)
          );
          if (text.startsWith("select ")) {
            rows.sort(
              (a, b) =>
                String(a.expires_at).localeCompare(String(b.expires_at)) ||
                String(a.id).localeCompare(String(b.id))
            );
            const result = this.response(
              q,
              rows.slice(0, Number(values.at(-1)))
            );
            const gate = this.afterSelect;
            this.afterSelect = undefined;
            await gate?.();
            return result;
          }
          const token = /set "state" = \$(\d+)/.exec(text)?.[1];
          if (!token) throw new Error("Missing state CAS");
          const next = values[Number(token) - 1];
          if (next === "refund_enqueued" && this.failEnqueued)
            throw new Error("Controlled outbox acknowledgement failure");
          for (const row of rows) {
            row.state = next;
            row.updated_at = new Date(this.now).toISOString();
          }
          if (next === "dispatched" && rows.length && this.loseDispatchAck) {
            this.loseDispatchAck = false;
            throw new Error("Controlled dispatch ACK loss");
          }
          return this.response(q, rows);
        }
        if (text.startsWith("select ") && text.includes('from "user"'))
          return { rows: [], rowCount: 0 };
        return base.query(q, values);
      },
    } as T;
  }
}

/** 初始 capture 仍走真实 core 的批次→Key→钱包 SQL，只扩展新表。 */
export class RelayCaptureDatabase extends ConsumptionDatabase {
  store = new RelayIntentStore();
  client(id: number) {
    const base = this.store.client(super.client(id), id);
    return {
      query: async (q: Query, values: unknown[] = []) => {
        if (q.text.startsWith('update "credits_transaction"')) {
          this.queries.push({ client: id, text: q.text, values });
          const patch = JSON.parse(String(values[0])) as Row;
          for (const row of this.entries) {
            if (
              row.user_id === values[1] &&
              row.type === values[2] &&
              row.source_ref === values[3]
            )
              row.metadata = { ...(row.metadata as Row), ...patch };
          }
          return { rows: [], rowCount: 1 };
        }
        if (
          q.text.includes('from "generation"') ||
          q.text.startsWith('update "generation"')
        ) {
          this.queries.push({ client: id, text: q.text, values });
          return { rows: [], rowCount: 0 };
        }
        return base.query(q, values);
      },
    };
  }
}

/** 已提交快照的退款阶段，保留新表状态；退款计算、原 Key 归属、outbox 都走真实函数。 */
export class RelayRefundDatabase extends ControlledLedger {
  store = new RelayIntentStore();
  client(id: number) {
    return this.store.client(super.client(id), id);
  }
}

/** 测试切换受控数据库后端时，只搬运已提交资金状态；不伪造业务完成或退款。 */
export function refundDatabaseFromCapture(capture: RelayCaptureDatabase) {
  const refund = new RelayRefundDatabase();
  refund.store = capture.store;
  refund.wallet = Number(capture.wallets.get("u1")?.balance);
  refund.pool = Number(capture.batches.get("b1")?.remaining);
  refund.keys = structuredClone(capture.keys);
  refund.rows = structuredClone(capture.entries);
  return refund;
}
