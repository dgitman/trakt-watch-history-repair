import { registerHooks } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers")
      return { url: "stub:workers", shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === "stub:workers")
      return {
        format: "module",
        source:
          "export class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env}}",
        shortCircuit: true,
      };
    return next(url, context);
  },
});
const { DavEmalieSync, default: worker } = await import("../src/index.ts");
function fixture() {
  const data = new Map();
  const storage = {
    get: async (k) => structuredClone(data.get(k)),
    put: async (k, v) => data.set(k, structuredClone(v)),
    delete: async (k) =>
      Array.isArray(k) ? k.map((x) => data.delete(x)) : data.delete(k),
  };
  let emails = 0;
  const env = {
    ADMIN_KEY: "test-only",
    ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
    ALERT_TO: "test@example.com",
    ALERT_FROM: "test@example.com",
    EMAIL: {
      send: async () => {
        emails++;
        return { messageId: "test" };
      },
    },
  };
  const obj = new DavEmalieSync({ storage }, env);
  return {
    obj,
    data,
    env,
    get emails() {
      return emails;
    },
  };
}
test("Worker rejects unauthorized and malformed requests", async () => {
  const f = fixture();
  assert.equal(
    (
      await worker.fetch(
        new Request("https://example.com/status", { method: "POST" }),
        f.env,
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await worker.fetch(
        new Request("https://example.com/status", {
          method: "POST",
          headers: { Authorization: "Bearer test-only" },
          body: "null",
        }),
        f.env,
      )
    ).status,
    400,
  );
});
test("OAuth tokens are encrypted and decrypt correctly", async () => {
  const f = fixture();
  const token = { access_token: "test-only-token" };
  const sealed = await f.obj.seal(token);
  assert.ok(!JSON.stringify(sealed).includes(token.access_token));
  assert.deepEqual(await f.obj.unseal(sealed), token);
});
test("wrong account identity is rejected", async () => {
  const f = fixture();
  f.obj.api = async () =>
    Response.json({
      user: { username: "someone_else", ids: { slug: "someone-else" } },
    });
  await assert.rejects(f.obj.identity("david"), /identity mismatch/);
});
test('daily cron routes to history checking and repair',async()=>{
 let checks=0;const pending=[];
 const env={SYNC:{getByName:()=>({historyCheck:async()=>{checks++}})}};
 await worker.scheduled({cron:'35 12 * * *'},env,{waitUntil:p=>pending.push(p)});
 await worker.scheduled({cron:'17 * * * *'},env,{waitUntil:p=>pending.push(p)});
 await Promise.all(pending);assert.equal(checks,1);
});
test('history scan checks identities, reports issues, and deduplicates alerts',async()=>{
 const f=fixture();let identities=0,calls=0;
 f.obj.identity=async()=>{identities++};
 f.obj.api=async(side,path,data)=>{assert.equal(data,undefined);calls++;return Response.json([{id:1,type:'movie',watched_at:'1970-01-01T00:00:00Z',movie:{title:'Example',released:'2020-01-01'}}],{headers:{'x-pagination-page-count':'1','x-pagination-item-count':'1'}})};
 await f.obj.historyCheck();await f.obj.historyCheck();
 assert.equal(identities,2);assert.equal(calls,2);assert.equal(f.emails,1);
 assert.equal(f.data.get('history:lastRun').counts.david.issues,1);
});
test('failed history scan retains prior complete report',async()=>{
 const f=fixture();f.data.set('history:summary:david',{scanned:99});
 f.obj.identity=async()=>{};f.obj.api=async()=>{throw Error('Trakt unavailable')};
 await assert.rejects(f.obj.historyCheck(),/Trakt unavailable/);
 assert.deepEqual(f.data.get('history:summary:david'),{scanned:99});assert.equal(f.emails,1);
});
test('explicit rate-limit rejection retries without repeating an accepted write',async()=>{
 const f=fixture(),original=globalThis.fetch;let calls=0;
 globalThis.fetch=async()=>++calls===1?new Response('',{status:429,headers:{'Retry-After':'0'}}):Response.json({added:{movies:1}});
 try {
  const r=await f.obj.api('david','/sync/history',{movies:[]},{access_token:'test'});
  assert.equal(r.status,200);assert.equal(calls,2);
 } finally {globalThis.fetch=original;}
});
test('authorization errors include Trakt error reason',async()=>{
 const f=fixture(),original=globalThis.fetch;
 globalThis.fetch=async()=>Response.json({error:'invalid_grant',error_description:'session not found'},{status:400});
 try {await assert.rejects(f.obj.oauth('/oauth/token',{}),/HTTP 400 \(invalid_grant: session not found\)/);}
 finally {globalThis.fetch=original;}
});
test('token requests never send a client secret',async()=>{
 const f=fixture(),original=globalThis.fetch;let body;
 f.env.TRAKT_CLIENT_ID='test-client';
 globalThis.fetch=async(_u,init)=>{body=JSON.parse(init.body);return Response.json({device_code:'d'})};
 try {await f.obj.oauth('/oauth/device/code',{});assert.deepEqual(body,{client_id:'test-client'});}
 finally {globalThis.fetch=original;}
});
