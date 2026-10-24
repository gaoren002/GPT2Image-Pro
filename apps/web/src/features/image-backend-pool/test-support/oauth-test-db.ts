/** PL12 SQL替身：解释本模块实际条件、主键/身份唯一键，事务排队及回滚；不替代真实PG验收。 */
import { AsyncLocalStorage } from "node:async_hooks";
import { getTableName, type SQL, type Table } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
type Row = Record<string, unknown>;
const dialect = new PgDialect();
const tables = new Map<string, Row[]>();
const scope = new AsyncLocalStorage<boolean>();
let queue = Promise.resolve();
export const oauthDbState = {
  failAccounts: false,
  failDone: false,
  failStage: false,
  failStageForId: null as string | null,
  inTransaction: () => scope.getStore() === true,
  statements: [] as string[],
};
/** 只重置本测试模块的表，运行时凭据始终为合成字符串。 */
export function resetOAuthDb() {
  tables.clear();
  queue = Promise.resolve();
  oauthDbState.failAccounts = false;
  oauthDbState.failDone = false;
  oauthDbState.failStage = false;
  oauthDbState.failStageForId = null;
  oauthDbState.statements = [];
}
/** 用于种子和结果断言。 */
export function oauthRows(name: string) {
  let rows = tables.get(name);
  if (!rows) {
    rows = [];
    tables.set(name, rows);
  }
  return rows;
}
/** 有界SQL条件解析，遇到未知语法直接失败而非放行。 */
function condition(expression: string, params: unknown[], row: Row): boolean {
  const text = expression.trim();
  if (text.startsWith("(")) {
    let depth = 0;
    let closes = -1;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "(") depth++;
      if (text[i] === ")" && --depth === 0) {
        closes = i;
        break;
      }
    }
    if (closes === text.length - 1)
      return condition(text.slice(1, -1), params, row);
  }
  for (const separator of [" or ", " and "]) {
    let depth = 0;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")") depth--;
      if (depth === 0 && text.startsWith(separator, i)) {
        const left = condition(text.slice(0, i), params, row),
          right = condition(text.slice(i + separator.length), params, row);
        return separator === " or " ? left || right : left && right;
      }
    }
  }
  const nullable = text.match(/^"\w+"\."(\w+)" is null$/);
  if (nullable?.[1])
    return (
      row[
        nullable[1].replace(/_([a-z])/g, (_, char: string) =>
          char.toUpperCase()
        )
      ] == null
    );
  if (text.includes(" <> "))
    return !condition(text.replace(" <> ", " = "), params, row);
  const match = text.match(/^"\w+"\."(\w+)" (= \$(\d+)|in \((.+)\))$/);
  if (!match?.[1]) throw new Error(`Unsupported test SQL ${text}`);
  const key =
    match[1] === "interface_mode"
      ? "implementationMode"
      : match[1].replace(/_([a-z])/g, (_, char: string) => char.toUpperCase());
  if (match[3]) return row[key] === params[Number(match[3]) - 1];
  return (match[4] ?? "")
    .split(",")
    .some((token) => row[key] === params[Number(token.trim().slice(1)) - 1]);
}
/** 编译真实Drizzle条件，以原参数求值；不读取SQL里的敏感值到测试日志。 */
function matches(where: SQL, row: Row) {
  const query = dialect.sqlToQuery(where);
  return condition(query.sql, query.params, row);
}
/** 故障异常刻意带合成凭据，验证上层不传播消息/params。 */
function failure(row: Row): never {
  throw Object.assign(
    new Error(
      `Failed query: credentials ${row.accessToken} ${row.refreshToken}`
    ),
    { code: "40P01" }
  );
}
export const oauthTestDb = {
  async transaction<T>(run: (tx: unknown) => Promise<T>): Promise<T> {
    const previous = queue;
    let release = () => {};
    queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const before = structuredClone(tables);
    try {
      return await scope.run(true, () => run(oauthTestDb));
    } catch (error) {
      tables.clear();
      for (const [name, rows] of before) tables.set(name, rows);
      throw error;
    } finally {
      release();
    }
  },
  async execute(statement: SQL) {
    const text = dialect.sqlToQuery(statement).sql;
    if (!text.includes("pg_advisory_xact_lock"))
      throw new Error("Unexpected SQL");
    oauthDbState.statements.push(text);
  },
  select(_fields?: unknown) {
    let name = "",
      where: SQL | undefined;
    const read = () =>
      structuredClone(
        oauthRows(name).filter((row) => !where || matches(where, row))
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
      orderBy(..._order: unknown[]) {
        return query;
      },
      async limit(n: number) {
        return read().slice(0, n);
      },
      async for(_mode: string) {
        return read();
      },
    };
    return query;
  },
  insert(table: Table) {
    const name = getTableName(table);
    return {
      values(input: Row | Row[]) {
        let ignoreConflict = false;
        const pending = Promise.resolve().then(() => {
          const inserted: Row[] = [];
          for (const value of Array.isArray(input) ? input : [input]) {
            if (name === "image_backend_account" && oauthDbState.failAccounts)
              failure(value);
            const conflict = oauthRows(name).find(
              (row) =>
                row.id === value.id ||
                (name === "image_backend_account" &&
                  row.implementationMode === value.implementationMode &&
                  (row.credentialHash === value.credentialHash ||
                    (value.oauthIdentityKey &&
                      row.oauthIdentityKey === value.oauthIdentityKey)))
            );
            if (conflict) {
              if (ignoreConflict) continue;
              throw Object.assign(new Error("Unique constraint conflict"), {
                code: "23505",
              });
            }
            const row = {
              createdAt: new Date(),
              updatedAt: new Date(),
              metadata: null,
              oauthIdentityKey: null,
              ...structuredClone(value),
            };
            oauthRows(name).push(row);
            inserted.push(row);
          }
          return inserted;
        });
        const returning = async (_fields?: unknown) =>
          structuredClone(await pending);
        return Object.assign(pending, {
          returning,
          onConflictDoNothing: () => {
            ignoreConflict = true;
            return Object.assign(pending, { returning });
          },
        });
      },
    };
  },
  update(table: Table) {
    const name = getTableName(table);
    return {
      set(value: Row) {
        return {
          where(where: SQL) {
            if (
              (name === "image_backend_account" && oauthDbState.failAccounts) ||
              (name === "image_backend_token_rotation" &&
                value.state === "done" &&
                oauthDbState.failDone) ||
              (name === "image_backend_token_rotation" &&
                value.state === "ready" &&
                (oauthDbState.failStage ||
                  (oauthDbState.failStageForId !== null &&
                    dialect
                      .sqlToQuery(where)
                      .params.includes(oauthDbState.failStageForId))))
            )
              failure(value);
            const updated: Row[] = [];
            for (const row of oauthRows(name))
              if (matches(where, row)) {
                Object.assign(row, structuredClone(value));
                updated.push(row);
              }
            return Object.assign(Promise.resolve(updated), {
              returning: async (_fields?: unknown) => structuredClone(updated),
            });
          },
        };
      },
    };
  },
  delete(table: Table) {
    return {
      async where(where: SQL) {
        const name = getTableName(table);
        tables.set(
          name,
          oauthRows(name).filter((row) => !matches(where, row))
        );
      },
    };
  },
};
