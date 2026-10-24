/** R14 DB-free SQL 替身：运行真实 Drizzle 条件，事务排队/回滚；不声称替代 PostgreSQL 调度验收。 */
import { getTableName, type SQL, type Table } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { AsyncLocalStorage } from "node:async_hooks";

type Row = Record<string, unknown>;
const dialect = new PgDialect();
const tables = new Map<string, Row[]>();
export const creemTestState = {
  inTransaction: false,
  statements: [] as string[],
};
let queue = Promise.resolve();
const transactionScope = new AsyncLocalStorage<boolean>();

/** 区分当前调用栈与其他并发事务，验证配置/grant 不嵌套借连接。 */
export function isCreemTestTransaction() {
  return transactionScope.getStore() === true;
}

/** 编译生产 SQL 条件，读取等值匹配；状态 CAS 的版本谓词另按真实参数求值。 */
function matches(where: SQL | undefined, row: Row): boolean {
  if (!where) return true;
  const query = dialect.sqlToQuery(where);
  if (query.sql.includes("->>'batchId'"))
    return (
      row.metadata !== null &&
      typeof row.metadata === "object" &&
      "batchId" in row.metadata &&
      row.metadata.batchId === query.params.at(-1)
    );
  for (const match of query.sql.matchAll(/"\w+"\."(\w+)" = \$(\d+)/g)) {
    const key = (match[1] ?? "").replace(/_([a-z])/g, (_, char: string) =>
      char.toUpperCase()
    );
    if (row[key] !== query.params[Number(match[2]) - 1]) return false;
  }
  if (query.sql.includes('"creem_event_created_at" <=')) {
    const incoming = query.params.at(-1);
    if (
      row.creemEventCreatedAt !== null &&
      typeof row.creemEventCreatedAt === "number" &&
      typeof incoming === "number" &&
      row.creemEventCreatedAt > incoming
    )
      return false;
  }
  return true;
}

/** 重置所有表；测试自行放入用户、订阅、账本，避免隐藏的默认查询结果。 */
export function resetCreemTestDb(seed: Record<string, Row[]> = {}) {
  tables.clear();
  for (const [name, rows] of Object.entries(seed))
    tables.set(name, structuredClone(rows));
  creemTestState.inTransaction = false;
  creemTestState.statements = [];
  queue = Promise.resolve();
}

/** 提供种子及结果断言入口。 */
export function creemTestRows(name: string): Row[] {
  let rows = tables.get(name);
  if (!rows) {
    rows = [];
    tables.set(name, rows);
  }
  return rows;
}

export const creemTestDb = {
  /** 所有短事务有序运行并在抛错时回滚；可断言 grant 不在事务中。 */
  async transaction<T>(run: (tx: unknown) => Promise<T>): Promise<T> {
    const previous = queue;
    let release = () => {};
    queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const before = structuredClone(tables);
    creemTestState.inTransaction = true;
    try {
      return await transactionScope.run(true, () => run(creemTestDb));
    } catch (error) {
      tables.clear();
      for (const [name, rows] of before) tables.set(name, rows);
      throw error;
    } finally {
      creemTestState.inTransaction = false;
      release();
    }
  },
  /** 只允许本专项的事务锁，不吞掉未知 SQL。 */
  async execute(statement: SQL) {
    const query = dialect.sqlToQuery(statement);
    creemTestState.statements.push(query.sql);
    if (!query.sql.includes("pg_advisory_xact_lock"))
      throw new Error(`Unexpected SQL: ${query.sql}`);
  },
  /** 选择真实表并按真实 where 过滤；for-update 由事务排队模型模拟。 */
  select(_fields?: unknown) {
    let name = "";
    let where: SQL | undefined;
    let descending = false;
    const read = () =>
      structuredClone(
        creemTestRows(name)
          .filter((row) => matches(where, row))
          .sort((a, b) =>
            descending ? Number(b.updatedAt) - Number(a.updatedAt) : 0
          )
      );
    const query = {
      from(table: Table) {
        name = getTableName(table);
        return query;
      },
      where(value: SQL) {
        where = value;
        return query;
      },
      orderBy(_value: unknown) {
        descending = true;
        return query;
      },
      async limit(count: number) {
        return read().slice(0, count);
      },
      async for(_mode: string) {
        return read();
      },
    };
    return query;
  },
  /** 事件/水位表的主键唯一约束和 upsert；身份冲突不改变原记录。 */
  insert(table: Table) {
    const name = getTableName(table);
    return {
      values(value: Row) {
        const apply = (updates?: Row) => {
          const key =
            name === "creem_webhook_event"
              ? "eventId"
              : name === "creem_subscription_state"
                ? "subscriptionId"
                : "id";
          const found = creemTestRows(name).find(
            (row) => row[key] === value[key]
          );
          if (found) {
            if (updates) Object.assign(found, structuredClone(updates));
          } else creemTestRows(name).push(structuredClone(value));
        };
        apply();
        return Object.assign(Promise.resolve(), {
          async onConflictDoNothing() {},
          async onConflictDoUpdate(options: { set: Row }) {
            apply(options.set);
          },
        });
      },
    };
  },
  /** 更新使用生产 WHERE 并记录编译结果，防止测试把无条件覆盖误当作 CAS。 */
  update(table: Table) {
    return {
      set(value: Row) {
        return {
          async where(where: SQL) {
            creemTestState.statements.push(dialect.sqlToQuery(where).sql);
            for (const row of creemTestRows(getTableName(table)))
              if (matches(where, row))
                Object.assign(row, structuredClone(value));
          },
        };
      },
    };
  },
};
