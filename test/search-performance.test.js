import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { openDatabase } from '../src/database.js';
import { sqliteAdapter } from '../src/db-adapter.js';
import { createApp } from '../src/app.js';

test('busca paginada consulta elegibilidade em lote, sem consultas por resultado',async t=>{
 const raw=openDatabase(':memory:'),db=sqliteAdapter(raw);let queries=0;
 const counted={...db,get:async(...args)=>{queries++;return db.get(...args);},all:async(...args)=>{queries++;return db.all(...args);}};
 const errors=[];
 const server=createApp({db:counted,logger:{warn:()=>{},error:e=>errors.push(e)}});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await db.close();assert.deepEqual(errors,[]);});
 const base=`http://127.0.0.1:${server.address().port}`;
 const registration=await fetch(base+'/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Performance',email:'performance@example.test',password:'Segura123'})});
 const {data:account}=await registration.json();
 const headers={Authorization:`Bearer ${account.token}`,'Content-Type':'application/json'};
 const classId=(await db.get("SELECT id FROM classes WHERE name='Clérigo'")).id;
 const character=await fetch(base+'/api/characters',{method:'POST',headers,body:JSON.stringify({name:'Clérigo',classId})});
 const {data:c}=await character.json();
 let previous;
 for(const limit of [1,40]){
  queries=0;
  const response=await fetch(base+`/api/spells?characterId=${c.id}&classId=${classId}&limit=${limit}`,{headers});
  const payload=await response.json();
  assert.equal(response.status,200);assert.equal(payload.data.length,limit);
  assert.ok(payload.data.every(s=>s.canPrepare===true&&s.isPrepared===false));
  assert.match(response.headers.get('Server-Timing'),/^api;dur=\d+\.\d$/);
  assert.equal(queries,8);
  if(previous!==undefined)assert.equal(queries,previous);previous=queries;
 }
});