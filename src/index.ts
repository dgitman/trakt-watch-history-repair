import { repairHistory, type Finding, type Repair } from "./history-repair.ts";
import type { HistoryRow } from "./history.ts";
import { scanHistory } from "./history.ts";
import { timingSafeEqual } from "node:crypto";
import { DurableObject } from "cloudflare:workers";
type Side = "david";
const sides: Side[] = ["david"];
const accounts = {
  david: "jarvis-16819012",
};
type Token = {
  access_token: string;
  refresh_token: string;
  created_at: number;
  expires_in: number;
};
const normalize = (s: string) => s.replaceAll("_", "-");
const encode = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const decode = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export class DavEmalieSync extends DurableObject<Env> {
  private queue: Promise<unknown> = Promise.resolve();
  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }
  private async key() {
    return crypto.subtle.importKey(
      "raw",
      decode(this.env.ENCRYPTION_KEY),
      "AES-GCM",
      false,
      ["encrypt", "decrypt"],
    );
  }
  private async seal(value: unknown) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    return {
      iv: encode(iv),
      data: encode(
        new Uint8Array(
          await crypto.subtle.encrypt(
            { name: "AES-GCM", iv },
            await this.key(),
            new TextEncoder().encode(JSON.stringify(value)),
          ),
        ),
      ),
    };
  }
  private async unseal<T>(value: { iv: string; data: string }): Promise<T> {
    return JSON.parse(
      new TextDecoder().decode(
        await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: decode(value.iv) },
          await this.key(),
          decode(value.data),
        ),
      ),
    );
  }
  private async token(side: Side): Promise<Token> {
    const encrypted = await this.ctx.storage.get<{ iv: string; data: string }>(
      "token:" + side,
    );
    if (!encrypted) throw Error("Authorization missing: " + side);
    let t = await this.unseal<Token>(encrypted);
    if (Date.now() / 1000 > t.created_at + t.expires_in - 86400) {
      if (await this.ctx.storage.get("refreshing:" + side))
        throw Error("Token refresh interrupted; reconnect " + side);
      await this.ctx.storage.put("refreshing:" + side, true);
      t = (await this.oauth("/oauth/token", {
        refresh_token: t.refresh_token,
        grant_type: "refresh_token",
        redirect_uri: "urn:ietf:wg:oauth:2.0:oob",
      })) as Token;
      this.validateToken(t);
      await this.ctx.storage.put("token:" + side, await this.seal(t));
      await this.ctx.storage.delete("refreshing:" + side);
    }
    return t;
  }
  private validateToken(t: Token) {
    if (
      !t.access_token ||
      !t.refresh_token ||
      !Number.isFinite(t.created_at) ||
      !Number.isFinite(t.expires_in)
    )
      throw Error("Invalid authorization response");
  }
  private async oauth(path: string, data: object): Promise<unknown> {
    const r = await fetch("https://auth.trakt.tv" + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "trakt-list-sync/1.0",
      },
      body: JSON.stringify({
        ...data,
        client_id: this.env.TRAKT_CLIENT_ID,
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) throw Error("Trakt authorization HTTP " + r.status);
    return r.json();
  }
  private lastApiRequest = 0;
  private lastApiWrite = 0;
  private async api(side: Side, path: string, data?: object, override?: Token) {
    const t = override ?? (await this.token(side));
    for(let attempt=0;attempt<5;attempt++) {
    const delay = Math.max(0, 300 - (Date.now()-this.lastApiRequest), data ? 1100 - (Date.now()-this.lastApiWrite) : 0);
    if(delay) await new Promise(resolve=>setTimeout(resolve,delay));
    this.lastApiRequest=Date.now();
    if(data) this.lastApiWrite=Date.now();
    const r = await fetch("https://api.trakt.tv" + path, {
      method: data ? "POST" : "GET",
      headers: {
        Authorization: "Bearer " + t.access_token,
        "trakt-api-key": this.env.TRAKT_CLIENT_ID,
        "trakt-api-version": "2",
        "Content-Type": "application/json",
        "User-Agent": "trakt-list-sync/1.0",
      },
      body: data ? JSON.stringify(data) : undefined,
      signal: AbortSignal.timeout(20000),
    });
    if(r.status===429 && attempt<4) {
      const header=r.headers.get('Retry-After');
      const numeric=Number(header);
      const seconds=header && Number.isFinite(numeric)?numeric:header?Math.max(0,(Date.parse(header)-Date.now())/1000):30;
      await r.body?.cancel();
      await new Promise(resolve=>setTimeout(resolve,Math.min(120,Math.max(5,Number.isFinite(seconds)?seconds:30))*1000));
      continue;
    }
    if (!r.ok) throw Error("Trakt HTTP " + r.status + " for " + side);
    return r;
    }
    throw Error("Trakt rate limit persisted");
  }
  private async identity(side: Side, t?: Token) {
    const user = (await (
      await this.api(side, "/users/settings", undefined, t)
    ).json()) as { user: { username: string; ids: { slug: string } } };
    if (
      normalize(user.user.ids.slug) !== accounts[side] ||
      normalize(user.user.username) !== accounts[side]
    )
      throw Error("Account identity mismatch: " + side);
  }
  private async notify() {
    return this.env.EMAIL.send({
      from: this.env.ALERT_FROM,
      to: this.env.ALERT_TO,
      subject: "Trakt history repair: notification test",
      text: "This verifies the Cloudflare notification path for Trakt history repair.",
    });
  }
  private async repairOne(side: Side, finding: Finding, pending?: Repair) {
    return repairHistory(finding, {
      read: async f => {
        const rows: HistoryRow[] = [];
        let pages=1, count: number | undefined;
        const end=encodeURIComponent(new Date().toISOString());
        for(let page=1;page<=pages;page++) {
          const r=await this.api(side,`/sync/history/${f.type}s/${f.mediaId}?extended=full&limit=250&page=${page}&end_at=${end}`);
          const pc=r.headers.get("x-pagination-page-count"), ic=r.headers.get("x-pagination-item-count");
          if(pc===null || ic===null) throw Error("Missing title history pagination");
          const n=Number(ic), p=Math.max(1,Number(pc));
          if(!Number.isInteger(n) || n<0 || !Number.isInteger(p) || p>50 || (count!==undefined && (n!==count || p!==pages))) throw Error("Title history changed during read");
          count=n; pages=p;
          const batch=await r.json() as HistoryRow[];
          if(!Array.isArray(batch)) throw Error("Invalid title history");
          rows.push(...batch);
        }
        if(rows.length!==count || new Set(rows.map(x=>x.id)).size!==count || rows.some(x=>x.type!==f.type || (x.type==='movie'?x.movie:x.episode)?.ids?.trakt!==f.mediaId)) throw Error("Incomplete or mismatched title history");
        return rows;
      },
      post: async (path,body) => {
        await this.identity(side);
        return (await this.api(side,path,body)).json();
      },
      save: job => this.ctx.storage.put("history:pending:"+side,job),
      complete: async job => {
        await this.ctx.storage.put(`history:repair:${side}:${job.finding.id}`,{...job,completedAt:new Date().toISOString()});
        await this.ctx.storage.delete("history:pending:"+side);
      },
    },pending);
  }
  private async ratingsFingerprint(side: Side) {
    const rows: unknown[]=[];
    let pages=1, count: number|undefined;
    for(let page=1;page<=pages;page++) {
      const r=await this.api(side,`/sync/ratings?limit=250&page=${page}`);
      const pc=r.headers.get("x-pagination-page-count"),ic=r.headers.get("x-pagination-item-count");
      if(pc===null || ic===null) throw Error("Missing ratings pagination");
      const n=Number(ic),p=Math.max(1,Number(pc));
      if(!Number.isInteger(n)||n<0||!Number.isInteger(p)||p>100||(count!==undefined&&(count!==n||pages!==p))) throw Error("Ratings changed during read");
      count=n;pages=p;
      const batch=await r.json() as Array<{type:string;rating:number;rated_at:string;[key:string]:unknown}>;
      for(const x of batch) rows.push([x.type,(x[x.type] as {ids:{trakt:number}})?.ids?.trakt,x.rating,x.rated_at]);
    }
    if(rows.length!==count) throw Error("Incomplete ratings snapshot");
    return JSON.stringify(rows.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))));
  }
  async historyCheck() {
    return this.serialized(async () => {
      const at = new Date().toISOString();
      try {
        const results: Record<string, Awaited<ReturnType<typeof scanHistory>>> = {};
        const fixed: Record<string,number> = {david:0};
        // Validate both identities before any history write.
        for(const side of sides) await this.identity(side);
        for (const side of sides) {
          const pending=await this.ctx.storage.get<Repair>("history:pending:"+side);
          let beforeRatings: string | undefined;
          if(pending) {
            beforeRatings=await this.ratingsFingerprint(side);
            if((await this.repairOne(side,pending.finding,pending)).status==='fixed') fixed[side]++;
          }
          results[side] = await scanHistory(path => this.api(side, path), new Date().toISOString());
          const initialCount=results[side].scanned;
          for(const finding of results[side].issues.slice(0,100)) {
            if(!['placeholder','before_release'].includes(finding.reason) || !finding.mediaId || !finding.release || Date.parse(finding.release)>Date.now()) continue;
            beforeRatings ??= await this.ratingsFingerprint(side);
            if((await this.repairOne(side,finding)).status==='fixed') fixed[side]++;
          }
          if(fixed[side]) {
            results[side]=await scanHistory(path=>this.api(side,path),new Date().toISOString());
            if(results[side].scanned!==initialCount) throw Error('History count changed during repair: '+side);
          }
          if(beforeRatings!==undefined && beforeRatings!==await this.ratingsFingerprint(side)) throw Error('Ratings changed during repair: '+side);
        }
        // Persist each account independently to avoid the storage value size limit.
        for (const side of sides) {
          const { issues, ...summary } = results[side];
          await this.ctx.storage.put("history:summary:" + side, summary);
          const chunks = Math.ceil(issues.length / 100);
          for(let i=0;i<chunks;i++) await this.ctx.storage.put(`history:issues:${side}:${i}`, issues.slice(i*100,(i+1)*100));
          await this.ctx.storage.put("history:chunks:" + side, chunks);
        }
        const signature = JSON.stringify(sides.map(side => results[side].issues.map(x => [x.id,x.reason,x.release]).sort((a,b)=>String(a).localeCompare(String(b)))));
        const digest = encode(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(signature))));
        const total = sides.reduce((n,side)=>n+results[side].issues.length,0);
        if((total && await this.ctx.storage.get("history:notified") !== digest) || sides.some(side=>fixed[side]>0)) {
          await this.env.EMAIL.send({from:this.env.ALERT_FROM,to:this.env.ALERT_TO,
            subject:total?"Trakt history repair: remaining issues":"Trakt history dates repaired",
            text:sides.map(side => `${side}: ${results[side].scanned} watches checked; ${fixed[side]} repaired; ${results[side].issues.length} remaining date issues.\n`+
              results[side].issues.slice(0,30).map(x=>`${x.title}: ${x.reason}; watched ${x.watched_at}; release ${x.release ?? "unknown"}`).join("\n")).join("\n\n")+
              "\n\nEligible placeholder and before-release dates were replaced with release dates, preserving repeat watches and ratings. Full details are available through the authenticated history/report operation."});
          await this.ctx.storage.put("history:notified",digest);
        }
        if(!total) await this.ctx.storage.delete("history:notified");
        await this.ctx.storage.put("history:lastRun",{at,status:"success",counts:Object.fromEntries(sides.map(side=>[side,{scanned:results[side].scanned,issues:results[side].issues.length,fixed:fixed[side],unknownRelease:results[side].unknownRelease}]))});
        await this.ctx.storage.delete("history:lastError");
        return await this.ctx.storage.get("history:lastRun");
      } catch(e) {
        const error=e instanceof Error?e.message:"History scan failed";
        await this.ctx.storage.put("history:lastRun",{at,status:"failed",error});
        if(await this.ctx.storage.get("history:lastError")!==error) {
          await this.env.EMAIL.send({from:this.env.ALERT_FROM,to:this.env.ALERT_TO,subject:"Trakt daily history check failed",text:error+"\nThe repair journal was retained. Some repairs may have completed; interrupted work will be reconciled before any further changes."});
          await this.ctx.storage.put("history:lastError",error);
        }
        throw Error(error);
      }
    });
  }
  async admin(path: string, body: Record<string, unknown>) {
    return this.serialized(async () => {
      const side = body.side as Side;
      if (path.startsWith("/auth/")) {
        if (!sides.includes(side)) throw Error("Invalid account");
        if (path === "/auth/start") {
          const device = (await this.oauth("/oauth/device/code", {})) as {
            device_code: string;
            user_code: string;
            verification_url: string;
            expires_in: number;
            interval: number;
          };
          await this.ctx.storage.put(
            "device:" + side,
            await this.seal({
              ...device,
              expiresAt: Date.now() + device.expires_in * 1000,
            }),
          );
          return {
            user_code: device.user_code,
            verification_url: device.verification_url,
            expires_in: device.expires_in,
            interval: device.interval,
          };
        }
        if (path === "/auth/poll") {
          const sealed = await this.ctx.storage.get<{
            iv: string;
            data: string;
          }>("device:" + side);
          if (!sealed) throw Error("Start authorization first");
          const d = await this.unseal<{
            device_code: string;
            expiresAt: number;
          }>(sealed);
          if (d.expiresAt < Date.now()) throw Error("Device code expired");
          const t = (await this.oauth("/oauth/device/token", {
            code: d.device_code,
          })) as Token;
          this.validateToken(t);
          await this.identity(side, t);
          await this.ctx.storage.put("token:" + side, await this.seal(t));
          await this.ctx.storage.delete([
            "device:" + side,
            "refreshing:" + side,
          ]);
          return { authorized: side };
        }
      }
      if (path === "/notifications/test") {
        const result = await this.notify();
        await this.ctx.storage.put(
          "notificationsVerifiedAt",
          new Date().toISOString(),
        );
        return { sent: true, result };
      }
      if (path === "/history/report") {
        const results: Record<string, unknown> = {};
        for(const side of sides) {
          const count = (await this.ctx.storage.get<number>("history:chunks:"+side)) ?? 0;
          const issues: unknown[] = [];
          for(let i=0;i<count;i++) issues.push(...((await this.ctx.storage.get<unknown[]>(`history:issues:${side}:${i}`)) ?? []));
          results[side] = {summary:await this.ctx.storage.get("history:summary:"+side),issues};
        }
        return {lastRun:await this.ctx.storage.get("history:lastRun"),pending:{david:await this.ctx.storage.get("history:pending:david")},results};
      }
      if (path === "/status")
        return {
          historyLastRun: await this.ctx.storage.get("history:lastRun"),
          authorized: {
            david: !!(await this.ctx.storage.get("token:david")),
          },
        };
      throw Error("Unknown operation");
    });
  }
}
export default {
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ) {
    if (_controller.cron === "35 12 * * *")
      ctx.waitUntil(env.SYNC.getByName("davemalie").historyCheck());
  },
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST")
      return new Response("Not found", { status: 404 });
    const provided = request.headers.get("Authorization") ?? "";
    const digest = async (s: string) =>
      crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
    if (
      !env.ADMIN_KEY ||
      !timingSafeEqual(
        new Uint8Array(await digest(provided)),
        new Uint8Array(await digest("Bearer " + env.ADMIN_KEY)),
      )
    )
      return new Response("Unauthorized", { status: 401 });
    if (Number(request.headers.get("content-length") ?? 0) > 16384)
      return new Response("Too large", { status: 413 });
    try {
      const reader = request.body?.getReader();
      let text = "";
      let length = 0;
      const decoder = new TextDecoder();
      if (reader) {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          length += part.value.byteLength;
          if (length > 16384) {
            await reader.cancel();
            return new Response("Too large", { status: 413 });
          }
          text += decoder.decode(part.value, { stream: true });
        }
        text += decoder.decode();
      }
      const body = text ? JSON.parse(text) : {};
      if (!body || typeof body !== "object" || Array.isArray(body))
        return new Response("Invalid body", { status: 400 });
      const path = new URL(request.url).pathname;
      const object = env.SYNC.getByName("davemalie");
      return Response.json(
        path === "/history/check" ? await object.historyCheck() : await object.admin(path, body),
        { headers: { "Cache-Control": "no-store" } },
      );
    } catch (e) {
      return Response.json(
        { error: e instanceof Error ? e.message : "Operation failed" },
        { status: 409, headers: { "Cache-Control": "no-store" } },
      );
    }
  },
} satisfies ExportedHandler<Env>;
