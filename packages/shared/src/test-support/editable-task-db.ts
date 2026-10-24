/** R05 专用驱动：真实 Drizzle SQL + 事务写集/任务行锁；继承已有钱包/Key/流水模型。 */
import {
  ConsumptionDatabase,
  consumptionGate,
} from "../credits/test-support/consumption-db";
type Row = Record<string, unknown>;
type Query = { text: string; rowMode?: string };

/** 扩展消费模型，仅实现本专项 SQL；未知表达式报错，不擅自补安全谓词。 */
export class EditableTaskDatabase extends ConsumptionDatabase {
  tasks = new Map<string, Row>();
  outbox = new Map<string, Row>();
  now = Date.now();
  failCompletion = false;
  loseCompletionAck = false;
  loseCaptureAck = false;
  beforeCaptureCommit: (() => Promise<void>) | undefined;

  override client(id: number) {
    const base = super.client(id);
    const tasks = new Map<string, Row>();
    const intents = new Map<string, Row>();
    let active = false;
    let captured = false;
    let completed = false;
    const allTasks = () => new Map([...this.tasks, ...tasks]);
    const lock = async (key: string) => {
      while (this.locks.has(key) && this.locks.get(key)?.owner !== id)
        await this.locks.get(key)?.done.promise;
      if (active && !this.locks.has(key))
        this.locks.set(key, { owner: id, done: consumptionGate() });
    };
    const match = (row: Row, where: string, values: unknown[]) => {
      for (const [, field, parameter] of where.matchAll(
        /"([a-z_]+)" = \$(\d+)/g
      ))
        if (row[field ?? ""] !== values[Number(parameter) - 1]) return false;
      for (const [, field, tokens] of where.matchAll(
        /"([a-z_]+)" in \(([^)]+)\)/g
      )) {
        const accepted = Array.from((tokens ?? "").matchAll(/\$(\d+)/g)).map(
          (m) => values[Number(m[1]) - 1]
        );
        if (!accepted.includes(row[field ?? ""])) return false;
      }
      const expired = new Date(String(row.expires_at)).getTime() <= this.now;
      if (where.includes('"expires_at" > clock_timestamp()') && expired)
        return false;
      if (where.includes('"expires_at" <= clock_timestamp()') && !expired)
        return false;
      return true;
    };
    return {
      query: async (config: Query, values: unknown[] = []) => {
        const text = config.text;
        if (text.startsWith("begin")) {
          active = true;
          return base.query(config, values);
        }
        if (text === "commit") {
          if (captured) await this.beforeCaptureCommit?.();
          for (const [key, row] of tasks) this.tasks.set(key, row);
          for (const [key, row] of intents) this.outbox.set(key, row);
          const result = await base.query(config, values);
          active = false;
          if (
            (completed && this.loseCompletionAck) ||
            (captured && this.loseCaptureAck)
          )
            throw new Error("Injected COMMIT acknowledgment loss");
          return result;
        }
        if (text === "rollback") {
          if (!active) return { rows: [] };
          active = false;
          tasks.clear();
          intents.clear();
          return base.query(config, values);
        }
        const where =
          text
            .split(" where ")[1]
            ?.split(/ order by | limit | for update| returning /)[0] ?? "";
        if (
          text.startsWith("select ") &&
          text.includes(' from "credits_transaction"') &&
          text.includes('"source_ref" in')
        ) {
          this.queries.push({ client: id, text, values });
          const refs = values.slice(2, -1);
          return this.response(
            config,
            this.entries
              .filter(
                (row) =>
                  row.user_id === values[0] &&
                  row.type === values[1] &&
                  refs.includes(row.source_ref)
              )
              .slice(0, 1)
          );
        }
        if (
          text.startsWith("select ") &&
          text.includes(' from "credits_transaction"') &&
          text.includes("->>'generationId'")
        ) {
          this.queries.push({ client: id, text, values });
          const user = values[0];
          const generationId = values.at(-1);
          return this.response(
            config,
            this.entries.filter(
              (row) =>
                row.user_id === user &&
                (row.type === "consumption" || row.type === "refund") &&
                (row.source_ref === generationId ||
                  (row.metadata as Row)?.generationId === generationId)
            )
          );
        }
        if (
          text.startsWith('insert into "editable_file_task"') ||
          text.startsWith('insert into "generation_refund_outbox"')
        ) {
          this.queries.push({ client: id, text, values });
          const parsed = /\((.*?)\) values \((.*?)\) on conflict/.exec(text);
          if (!parsed?.[1] || !parsed[2])
            throw new Error(`Unknown insert: ${text}`);
          const tokens = parsed[2].split(", ");
          const row: Row = {};
          parsed[1].split(", ").forEach((field, index) => {
            const name = field.replaceAll('"', "");
            const token = tokens[index] ?? "default";
            row[name] = token.startsWith("$")
              ? values[Number(token.slice(1)) - 1]
              : name === "expires_at"
                ? new Date(this.now + 30 * 60_000).toISOString()
                : name.endsWith("_at")
                  ? new Date(this.now).toISOString()
                  : name === "state"
                    ? "pending"
                    : name === "attempts"
                      ? 0
                      : null;
          });
          const isTask = text.includes('"editable_file_task"');
          const key = isTask
            ? String(row.id)
            : JSON.stringify([row.user_id, row.source_ref]);
          await lock(`${isTask ? "task" : "outbox"}:${key}`);
          if (
            (isTask ? allTasks() : new Map([...this.outbox, ...intents])).has(
              key
            )
          )
            return this.response(config, []);
          (isTask ? tasks : intents).set(key, row);
          return this.response(config, [row]);
        }
        if (
          text.startsWith("select ") &&
          text.includes(' from "editable_file_task"')
        ) {
          this.queries.push({ client: id, text, values });
          if (text.includes("for update"))
            await lock(`task:${String(values[0])}`);
          let found = [...allTasks().values()].filter((row) =>
            match(row, where, values)
          );
          if (text.includes(" limit "))
            found = found.slice(0, Number(values.at(-1)));
          if (text.includes('as "remaining_ms"')) {
            const remaining = found.map((row) =>
              Math.floor(new Date(String(row.expires_at)).getTime() - this.now)
            );
            return config.rowMode === "array"
              ? {
                  rows: remaining.map((value) => [value]),
                  rowCount: remaining.length,
                }
              : {
                  rows: remaining.map((value) => ({ remaining_ms: value })),
                  rowCount: remaining.length,
                };
          }
          return this.response(config, found);
        }
        if (text.startsWith('update "editable_file_task"')) {
          this.queries.push({ client: id, text, values });
          const found: Row[] = [];
          for (const row of allTasks().values()) {
            if (!match(row, where, values)) continue;
            await lock(`task:${String(row.id)}`);
            const current = allTasks().get(String(row.id));
            if (!current || !match(current, where, values)) continue;
            const next = { ...current };
            const set = text.split(" set ")[1]?.split(" where ")[0] ?? "";
            for (const [, field, parameter] of set.matchAll(
              /"([a-z_]+)" = \$(\d+)/g
            )) {
              const value = values[Number(parameter) - 1];
              next[field ?? ""] =
                field === "result_references" && typeof value === "string"
                  ? JSON.parse(value)
                  : value;
            }
            if (set.includes("clock_timestamp() + interval '60 seconds'"))
              next.expires_at = new Date(this.now + 60_000).toISOString();
            if (next.state === "completed" && this.failCompletion)
              throw new Error("Injected completion update failure");
            if (next.state === "completed") completed = true;
            if (next.state === "running") captured = true;
            (active ? tasks : this.tasks).set(String(row.id), next);
            found.push(next);
          }
          return this.response(config, found);
        }
        return base.query(config, values);
      },
    };
  }
}
