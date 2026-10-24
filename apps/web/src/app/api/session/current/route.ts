/** 权威会话端点：复查用户、清理失效 cookie、禁止缓存，响应不包含可重放的会话 token。 */
import { db, user } from "@repo/database";
import { auth } from "@repo/shared/auth";
import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { isAuthCookieName, toCurrentSessionUser } from "./session-current-core";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

function withNoStore(response: NextResponse) {
  response.headers.set(
    "Cache-Control",
    "private, no-store, no-cache, max-age=0, must-revalidate"
  );
  response.headers.set("CDN-Cache-Control", "no-store");
  response.headers.set("Cloudflare-CDN-Cache-Control", "no-store");
  response.headers.set("Pragma", "no-cache");
  response.headers.set("Expires", "0");
  response.headers.set("Vary", "Cookie");
  return response;
}

async function clearAuthCookies(response: NextResponse) {
  const cookieStore = await cookies();

  for (const cookie of cookieStore.getAll()) {
    if (isAuthCookieName(cookie.name)) {
      response.cookies.set(cookie.name, "", {
        path: "/",
        maxAge: 0,
        secure: cookie.name.startsWith("__Secure-"),
        httpOnly: true,
        sameSite: "lax",
      });
    }
  }

  return response;
}

export async function GET() {
  return getCurrentSessionResponse();
}

export async function POST() {
  return getCurrentSessionResponse();
}

async function getCurrentSessionResponse() {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session?.user?.id) {
    return clearAuthCookies(withNoStore(NextResponse.json(null)));
  }

  const [currentUser] = await db
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      image: user.image,
      role: user.role,
      banned: user.banned,
      bannedReason: user.bannedReason,
    })
    .from(user)
    .where(eq(user.id, session.user.id))
    .limit(1);

  if (!currentUser) {
    return clearAuthCookies(withNoStore(NextResponse.json(null)));
  }

  const { token: _token, ...sessionMetadata } = session.session;
  return withNoStore(
    NextResponse.json({
      ...session,
      session: sessionMetadata,
      user: toCurrentSessionUser(currentUser),
    })
  );
}
