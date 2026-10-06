import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/database.js';

async function fixture(t,db=openDatabase(':memory:')) {
  const logs=[];
  const server=createApp({db,logger:{warn:line=>logs.push(JSON.parse(line)),error:line=>logs.push(JSON.parse(line))}});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await db.close?.();});
  return {logs,request:(path,options)=>fetch(`http://127.0.0.1:${server.address().port}${path}`,options)};
}

test('warnings em todas as rotas: validação, autenticação, CORS, 404 e 405',async t=>{
  const {logs,request}=await fixture(t);
  for(const [path,options,status,route,code] of [
    ['/api/spells?name=segredo',{},401,'/api/spells','UNAUTHENTICATED'],
    ['/api/characters/123',{},401,'/api/characters/:id','UNAUTHENTICATED'],
    ['/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Teste',email:'secreto@example.test',password:'segredo'})},400,'/api/auth/register','VALIDATION_ERROR'],
    ['/api/auth/login',{method:'PATCH'},405,'/api/auth/login','METHOD_NOT_ALLOWED'],
    ['/segredo-token',{},404,'[unmatched]','NOT_FOUND'],
    ['/api/health',{headers:{Origin:'https://secreto.example.test'}},403,'/api/health','CORS_FORBIDDEN'],
  ]) {
    const response=await request(path,options);await response.text();
    assert.equal(response.status,status);
    const log=logs.at(-1);
    assert.equal(log.level,'warn');assert.equal(log.route,route);assert.equal(log.code,code);
    assert.equal(log.requestId,response.headers.get('X-Request-Id'));
    assert.ok(log.durationMs>=0);assert.ok(!JSON.stringify(log).includes('secreto'));assert.ok(!JSON.stringify(log).includes('segredo'));
  }
  assert.equal(logs.length,6);
  const response=await request('/api/health');await response.text();assert.equal(response.status,200);
  assert.equal(logs.length,6);
});

test('500 gera um único error estruturado sem dados internos do driver',async t=>{
  const db={dialect:'postgres',version:async()=>{throw Object.assign(new Error('postgresql://usuario:senha-secreta@host SQL secreto'),{code:'ECONNRESET'});}};
  const {logs,request}=await fixture(t,db);
  const response=await request('/api/health');await response.text();
  assert.equal(response.status,500);assert.equal(logs.length,1);
  assert.equal(logs[0].level,'error');assert.equal(logs[0].route,'/api/health');
  assert.equal(logs[0].code,'INTERNAL_ERROR');assert.deepEqual(logs[0].error,{type:'Error',code:'ECONNRESET'});
  assert.ok(!JSON.stringify(logs).includes('senha-secreta'));assert.ok(!JSON.stringify(logs).includes('SQL secreto'));
});
