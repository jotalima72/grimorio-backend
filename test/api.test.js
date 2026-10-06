import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/database.js';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import { postgresFixture } from './postgres-fixture.js';

test('cadastro exige oito caracteres, maiúscula, minúscula e número; login mantém contas existentes',async t=>{
  const f=await fixture();t.after(f.close);
  for(const password of ['Abcdef1','abcdefgh1','ABCDEFGH1','Abcdefgh']) {
    const r=await f.request('/api/auth/register',{method:'POST',body:{name:'Teste',email:'regra@example.test',password}});
    assert.equal(r.status,400,password);
    assert.equal(r.error.code,'VALIDATION_ERROR');
  }
  for(const [i,password] of ['Abcdefg1','Ábcdefg1'].entries()) {
    assert.equal((await f.request('/api/auth/register',{method:'POST',body:{name:'Teste',email:`regra${i}@example.test`,password}})).status,201);
  }
  const hash=await hashPassword('senha-antiga-123');
  (await f.db.prepare('INSERT INTO users(name,email,password_hash) VALUES(?,?,?)').run('Antigo','antigo@example.test',hash));
  assert.equal((await f.request('/api/auth/login',{method:'POST',body:{email:'antigo@example.test',password:'senha-antiga-123'}})).status,200);
});

async function fixture(options={}) {
  const db=process.env.TEST_POSTGRES ? (await postgresFixture()).adapter : openDatabase(':memory:');
  const errors=[];
  const server=createApp({db,logger:{error:e=>errors.push(e)},authLimit:1000,...options});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${server.address().port}`;
  async function request(path,{method='GET',token,body,headers={}}={}) {
    if(token)headers.Authorization=`Bearer ${token}`;
    if(body!==undefined)headers['Content-Type']='application/json';
    const response=await fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
    const payload=response.status===204?null:await response.json();
    return {status:response.status,...payload};
  }
  async function register(name) {
    const r=await request('/api/auth/register',{method:'POST',body:{name,email:name+'@example.test',password:'Uma-senha-segura-123'}});
    assert.equal(r.status,201);return r.data;
  }
  const close=async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await db.close();assert.deepEqual(errors,[]);};
  return {db,server,base,request,register,close};
}

test('vínculos homebrew em lote: exclusão, isolamento, repetição e rollback',async t=>{
  const f=await fixture();t.after(f.close);const {request,register,db}=f;
  const ana=await register('lote-ana'),beto=await register('lote-beto');
  const token=ana.token;
  const classes=(await request('/api/classes',{token})).data;
  const classId=classes.find(c=>c.name==='Clérigo').id;
  const before=await request(`/api/spells?excludeClassId=${classId}&limit=500`,{token});
  assert.equal(before.status,200);assert.ok(before.data.length>2);
  const spellIds=before.data.slice(0,2).map(s=>s.id);
  const textBefore=(await request(`/api/spells/${spellIds[0]}`,{token})).data.description;
  const path=`/api/classes/${classId}/spells/batch`;
  const added=await request(path,{method:'POST',token,body:{spellIds}});
  assert.equal(added.status,200);assert.equal(added.data.added,2);assert.equal(added.data.skipped,0);
  const source=(await db.prepare('SELECT kind,owner_user_id AS ownerUserId FROM sources WHERE id=?').get(added.data.sourceId));
  assert.equal(source.kind,'homebrew');assert.equal(source.ownerUserId,ana.user.id);
  const after=await request(`/api/spells?excludeClassId=${classId}&limit=500`,{token});
  assert.equal(after.meta.total,before.meta.total-2);assert.ok(after.data.every(s=>!spellIds.includes(s.id)));
  assert.equal((await request(`/api/spells?excludeClassId=${classId}&limit=500`,{token:beto.token})).meta.total,before.meta.total);
  assert.equal((await request(`/api/spells/${spellIds[0]}`,{token})).data.description,textBefore);
  const repeated=await request(path,{method:'POST',token,body:{spellIds}});
  assert.equal(repeated.data.added,0);assert.equal(repeated.data.skipped,2);
  const pending=after.data[0].id;
  assert.equal((await request(path,{method:'POST',token,body:{spellIds:[pending,999999]}})).status,404);
  assert.equal((await request(`/api/spells?excludeClassId=${classId}&limit=500`,{token})).meta.total,after.meta.total);
  for(const ids of [[],[pending,pending],Array.from({length:501},(_,i)=>i+1)])assert.equal((await request(path,{method:'POST',token,body:{spellIds:ids}})).status,400);
  const privateClass=await request('/api/classes',{method:'POST',token,body:{name:'Classe privada'}});
  assert.equal((await request(`/api/classes/${privateClass.data.id}/spells/batch`,{method:'POST',token:beto.token,body:{spellIds}})).status,404);
  assert.equal((await request(`/api/spells?excludeClassId=${privateClass.data.id}`,{token:beto.token})).status,404);
  const privateSpell=await request('/api/spells',{method:'POST',token:beto.token,body:{name:'Segredo do lote',level:1,schoolId:1,components:'V',castingTime:'Ação',range:'Toque',duration:'Instantânea',description:'Descrição privada.'}});
  assert.equal(privateSpell.status,201);
  assert.equal((await request(path,{method:'POST',token,body:{spellIds:[pending,privateSpell.data.id]}})).status,404);
});

test('contrato completo: autenticação, catálogo, personagens, homebrew e preparação',async t=>{
  const f=await fixture();t.after(f.close);const {request,register,db}=f;
  let ana,beto,token,classes,schools,c,privateSource,newClass,newSpell;
  await t.test('health e autenticação com sessão persistida e hash de senha',async()=>{
    assert.equal((await request('/api/health')).status,200);
    assert.equal((await request('/api/spells')).status,401);
    ana=await register('ana');beto=await register('beto');token=ana.token;
    const stored=(await db.prepare('SELECT password_hash FROM users WHERE id=?').get(ana.user.id)).password_hash;
    assert.match(stored,/^scrypt\$/);assert.notEqual(stored,'Uma-senha-segura-123');
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).n,2);
    assert.equal((await db.prepare('SELECT 1 FROM sessions WHERE token_hash=?').get(token)),undefined);
    assert.equal((await request('/api/auth/me',{token})).data.id,ana.user.id);
    assert.equal((await request('/api/auth/register',{method:'POST',body:{name:'Outra',email:'ANA@example.test',password:'Uma-senha-segura-123'}})).status,409);
    for(const address of ['ana@example.test','inexistente@example.test']){
      const r=await request('/api/auth/login',{method:'POST',body:{email:address,password:'senha-errada-123'}});
      assert.equal(r.status,401);assert.equal(r.error.code,'INVALID_CREDENTIALS');
    }
    const login=await request('/api/auth/login',{method:'POST',body:{email:'ANA@example.test',password:'Uma-senha-segura-123'}});
    assert.equal(login.status,200);assert.equal(login.data.user.id,ana.user.id);
  });
  await t.test('catálogo com escolas separadas, filtros sem acento e texto preservado',async()=>{
    classes=(await request('/api/classes',{token})).data;schools=(await request('/api/schools',{token})).data;
    assert.equal(classes.length,8);assert.equal(schools.length,8);
    const r=await request('/api/spells?limit=500',{token});assert.equal(r.data.length,391);assert.equal(r.meta.total,391);
    for(const level of [0,1,9]) {
      const expected=r.data.filter(s=>s.level===level);
      const filtered=await request(`/api/spells?level=${level}&limit=500`,{token});
      assert.equal(filtered.status,200);
      assert.equal(filtered.meta.total,expected.length);
      assert.deepEqual(filtered.data.map(s=>s.id),expected.map(s=>s.id));
      const page=await request(`/api/spells?level=${level}&limit=2&offset=1`,{token});
      assert.equal(page.meta.total,expected.length);
      assert.deepEqual(page.data.map(s=>s.id),expected.slice(1,3).map(s=>s.id));
    }
    const combined=await request('/api/spells?level=0&name=moribundos&schoolId=2',{token});
    assert.ok(combined.data.every(s=>s.level===0&&s.schoolId===2));
    for(const value of ['10','-1','1.5','abc','']) assert.equal((await request(`/api/spells?level=${value}`,{token})).status,400);
    assert.equal(r.data[0].description,undefined);assert.equal(r.data[0].original_entry_json,undefined);
    const search=await request('/api/spells?name=emocoes',{token});assert.equal(search.data[0].name,'Acalmar Emoções');
    const a=(await request('/api/spells/2',{token})).data;
    assert.equal(a.components,'V, S');assert.equal(a.school,'Necromancia');assert.ok(a.classes.some(x=>x.name==='Druida'));
    assert.match(a.description,/18 me-\ntros/);
    assert.equal(a.original_entry_json,undefined);
    const classId=classes.find(x=>x.name==='Clérigo').id;
    assert.equal((await request(`/api/spells?classId=${classId}&limit=500`,{token})).meta.total,117);
    const schoolId=schools.find(x=>x.name==='Necromancia').id;
    const filtered=await request(`/api/spells?schoolId=${schoolId}`,{token});assert.equal(filtered.meta.total,31);
    for(const name of ['%','_',"' OR 1=1 --"]){assert.equal((await request('/api/spells?name='+encodeURIComponent(name),{token})).meta.total,0);}
    assert.equal((await request('/api/spells?limit=0',{token})).status,400);
    assert.equal((await request('/api/spells?sourceId=1',{token})).status,400);
  });
  await t.test('personagens separados por usuário e preparação idempotente',async()=>{
    const classId=classes.find(x=>x.name==='Clérigo').id;
    const made=await request('/api/characters',{method:'POST',token,body:{name:'Meu clérigo',classId,level:3}});
    assert.equal(made.status,201);c=made.data;
    assert.equal((await request(`/api/characters/${c.id}`,{token:beto.token})).status,404);
    assert.equal((await request(`/api/characters/${c.id}`,{method:'DELETE',token:beto.token})).status,404);
    assert.equal((await request('/api/characters',{token:beto.token})).data.length,0);
    assert.equal((await request('/api/characters',{method:'POST',token,body:{name:'Inválido',classId,userId:beto.user.id}})).status,400);
    const path=`/api/characters/${c.id}/prepared-spells/2`;
    assert.equal((await request(path,{method:'PUT',token})).status,200);
    assert.equal((await request(path,{method:'PUT',token})).status,200);
    assert.equal((await request(`/api/characters/${c.id}/prepared-spells`,{token})).data.length,1);
    assert.equal((await request(path,{method:'PUT',token:beto.token})).status,404);
    const wrong=(await db.prepare('SELECT spell_id AS id FROM class_spells WHERE class_id<>? AND spell_id NOT IN (SELECT spell_id FROM class_spells WHERE class_id=?) LIMIT 1').get(classId,classId)).id;
    assert.equal((await request(`/api/characters/${c.id}/prepared-spells/${wrong}`,{method:'PUT',token})).status,422);
    const annotated=await request(`/api/spells?name=moribundos&characterId=${c.id}`,{token});
    assert.equal(annotated.data[0].isPrepared,true);assert.equal(annotated.data[0].canPrepare,true);
    assert.equal((await request(`/api/spells?characterId=${c.id}`,{token:beto.token})).status,404);
  });
  await t.test('compêndio privado, nova classe e extensão de magia oficial',async()=>{
    privateSource=(await request('/api/sources',{method:'POST',token,body:{name:'Meu compêndio',kind:'compendium'}})).data;
    const added=await request('/api/classes',{method:'POST',token,body:{name:'Tecnomante',sourceId:privateSource.id}});
    assert.equal(added.status,201);newClass=added.data;
    assert.equal((await request('/api/classes',{token:beto.token})).data.some(x=>x.id===newClass.id),false);
    const link=await request(`/api/classes/${newClass.id}/spells`,{method:'POST',token,body:{spellId:2,sourceId:privateSource.id}});assert.equal(link.status,201);
    assert.equal((await request(`/api/classes/${newClass.id}/spells`,{method:'POST',token,body:{spellId:2,sourceId:privateSource.id}})).status,200);
    assert.equal((await request(`/api/spells?classId=${newClass.id}`,{token})).meta.total,1);
    assert.equal((await request(`/api/spells?classId=${newClass.id}`,{token:beto.token})).status,404);
    assert.equal((await request(`/api/spells/2`,{token:beto.token})).data.classes.some(x=>x.id===newClass.id),false);
    assert.equal((await request('/api/characters',{method:'POST',token:beto.token,body:{name:'Intruso',classId:newClass.id}})).status,404);
    assert.equal((await request(`/api/classes/${classes[0].id}/spells`,{method:'POST',token,body:{spellId:2,sourceId:1}})).status,403);
    assert.equal((await request('/api/sources',{method:'POST',token,body:{name:'Livro falso',kind:'book'}})).status,400);
    assert.equal((await request('/api/sources',{method:'POST',token,body:{name:'Ataque',kind:'homebrew',ownerUserId:beto.user.id}})).status,400);
  });
  await t.test('criação homebrew transacional, isolamento e edição preservando pontuação',async()=>{
    const body={name:'Minha Magia',level:1,schoolId:schools[0].id,components:'V, S, M (uma pena)',castingTime:'Ação',range:'9 metros',duration:'1 minuto',description:'Texto, com vírgulas.\nOutro parágrafo.  ',classIds:[newClass.id]};
    const created=await request('/api/spells',{method:'POST',token,body});assert.equal(created.status,201);newSpell=created.data;
    assert.equal(newSpell.sourceKind,'homebrew');assert.equal(newSpell.ownerUserId,ana.user.id);assert.equal(newSpell.description,body.description);
    assert.equal((await request(`/api/spells/${newSpell.id}`,{token:beto.token})).status,404);
    assert.equal((await request('/api/spells?name=minha',{token:beto.token})).data.some(x=>x.id===newSpell.id),false);
    assert.equal((await request(`/api/spells/${newSpell.id}`,{method:'PATCH',token:beto.token,body:{description:'Ataque'}})).status,404);
    assert.equal((await request('/api/spells/2',{method:'PATCH',token,body:{description:'Modificar livro'}})).status,403);
    const patched=await request(`/api/spells/${newSpell.id}`,{method:'PATCH',token,body:{name:'Magia de Névoa',description:'Descrição, nova.\nSem alteração automática.'}});
    assert.equal(patched.status,200);assert.equal(patched.data.description,'Descrição, nova.\nSem alteração automática.');
    assert.equal((await request('/api/spells?name=nevoa',{token})).data.some(x=>x.id===newSpell.id),true);
    const before=(await db.prepare('SELECT COUNT(*) AS n FROM spells').get()).n;
    assert.equal((await request('/api/spells',{method:'POST',token,body:{...body,name:'Falha',classIds:[99999]}})).status,404);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM spells').get()).n,before);
    assert.equal((await request('/api/spells',{method:'POST',token,body:{...body,level:10}})).status,400);
    assert.equal((await request('/api/spells',{method:'POST',token,body:{...body,imagePath:'javascript:alert(1)'}})).status,400);
    assert.equal((await request('/api/spells',{method:'POST',token,body:{...body,kind:'book'}})).status,400);
  });
  await t.test('troca de classe explícita e lista preparada própria',async()=>{
    const path=`/api/characters/${c.id}`;
    assert.equal((await request(path,{method:'PATCH',token,body:{classId:newClass.id}})).status,409);
    assert.equal((await request(path,{token})).data.classId,c.classId);
    assert.equal((await request(path,{method:'PATCH',token,body:{classId:newClass.id,clearPrepared:true}})).status,200);
    assert.equal((await request(path+'/prepared-spells',{token})).data.length,0);
    assert.equal((await request(path+`/prepared-spells/${newSpell.id}`,{method:'PUT',token})).status,200);
    const detail=(await request(path+'/prepared-spells',{token})).data[0];assert.equal(detail.name,'Magia de Névoa');assert.ok(detail.description);assert.ok(detail.preparedAt);
    assert.equal((await request(path+`/prepared-spells/${newSpell.id}`,{method:'DELETE',token})).status,204);
    assert.equal((await request(path+`/prepared-spells/${newSpell.id}`,{method:'DELETE',token})).status,204);
    assert.equal((await request(path+'/prepared-spells/2',{method:'PUT',token})).status,200);
    assert.equal((await request(path,{method:'DELETE',token})).status,204);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM prepared_spells WHERE character_id=?').get(c.id)).n,0);
  });
  await t.test('expiração e revogação de sessão',async()=>{
    const logout=await request('/api/auth/logout',{method:'POST',token});assert.equal(logout.status,204);
    assert.equal((await request('/api/auth/me',{token})).status,401);
    (await db.prepare('UPDATE sessions SET expires_at=0 WHERE user_id=?').run(beto.user.id));
    assert.equal((await request('/api/auth/me',{token:beto.token})).status,401);
    if (!process.env.TEST_POSTGRES) assert.equal((await db.prepare('PRAGMA integrity_check').get()).integrity_check,'ok');
    if (!process.env.TEST_POSTGRES) assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()),[]);
  });
});

test('JSON, CORS, limites de corpo e métodos HTTP',async t=>{
  const f=await fixture();t.after(f.close);const auth=await f.register('teste');
  assert.equal((await f.request('/api/spells',{token:auth.token,headers:{Origin:'https://evil.example'}})).status,403);
  const cors=await fetch(f.base+'/api/spells',{method:'OPTIONS',headers:{Origin:'http://localhost:5173'}});
  assert.equal(cors.status,204);assert.equal(cors.headers.get('Access-Control-Allow-Origin'),'http://localhost:5173');
  assert.equal((await f.request('/api/spells',{method:'DELETE',token:auth.token})).status,405);
  const invalid=await fetch(f.base+'/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:'{'});assert.equal(invalid.status,400);
  const wrong=await fetch(f.base+'/api/auth/register',{method:'POST',headers:{'Content-Type':'text/plain'},body:'{}'});assert.equal(wrong.status,415);
  const huge=await fetch(f.base+'/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({description:'x'.repeat(270000)})});assert.equal(huge.status,413);
});

test('limite de tentativas de autenticação',async t=>{
  const f=await fixture({authLimit:1});t.after(f.close);
  assert.equal((await f.request('/api/auth/login',{method:'POST',body:{}})).status,400);
  assert.equal((await f.request('/api/auth/register',{method:'POST',body:{}})).status,429);
});

test('inicialização e reabertura não duplicam catálogo; sessões sobrevivem',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'magias-api-')),path=join(dir,'test.sqlite');
  try{
    let db=openDatabase(path);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM spells').get()).n,391);
    (await db.prepare("INSERT INTO users(name,email,password_hash) VALUES('Persistente','p@example.test','hash')").run());
    (await db.prepare("INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES('hash-de-teste',1,?,?)").run(Date.now()+3600000,Date.now()));db.close();
    db=openDatabase(path);assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM spells').get()).n,391);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM class_spells').get()).n,987);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM users').get()).n,1);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).n,1);assert.equal((await db.prepare('PRAGMA user_version').get()).user_version,2);db.close();
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('migração do catálogo existente da versão 1 preserva os dados',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'magias-migration-')),path=join(dir,'catalog.sqlite');
  try {
    const {DatabaseSync}=await import('node:sqlite');let db=new DatabaseSync(path);
    db.exec(readFileSync(new URL('../database/001-catalog.sql',import.meta.url),'utf8'));
    db.exec(readFileSync(new URL('../database/seed.sql',import.meta.url),'utf8'));
    const original=(await db.prepare('SELECT description_text FROM spells WHERE id=2').get()).description_text;db.close();
    db=openDatabase(path);assert.equal((await db.prepare('PRAGMA user_version').get()).user_version,2);
    assert.equal((await db.prepare('SELECT description_text FROM spells WHERE id=2').get()).description_text,original);assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM users').get()).n,0);db.close();
  }finally{rmSync(dir,{recursive:true,force:true});}
});
