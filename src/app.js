import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { hashPassword, verifyPassword, createSession, tokenHash } from './auth.js';
import { adaptDatabase } from './db-adapter.js';
import { HttpError, fail, normalize, object, string, integer, queryInteger, ids, email, password } from './validation.js';

const summarySelect = `SELECT s.id,s.name,s.level,s.school_id AS schoolId,sc.name AS school,
 s.source_id AS sourceId,src.name AS source,src.kind AS sourceKind,
 src.owner_user_id AS ownerUserId FROM spells s
 JOIN schools sc ON sc.id=s.school_id JOIN sources src ON src.id=s.source_id`;
const detailSelect = summarySelect.replace(' FROM spells s', `,
 s.components_text AS components,s.casting_time_text AS castingTime,
 s.range_text AS range,s.duration_text AS duration,s.description_text AS description,
 s.image_path AS imagePath,s.source_page AS sourcePage,
 s.created_at AS createdAt,s.updated_at AS updatedAt FROM spells s`);
const spellFields = ['name','level','schoolId','components','castingTime','range','duration','description','imagePath'];
const columns = {name:'name',level:'level',schoolId:'school_id',components:'components_text',castingTime:'casting_time_text',range:'range_text',duration:'duration_text',description:'description_text',imagePath:'image_path'};

export function createApp({ db, corsOrigins = ['http://localhost:5173','http://127.0.0.1:5173'], sessionTtlHours = 168, authLimit = 30, logger = console }) {
  if (!Number.isFinite(sessionTtlHours) || sessionTtlHours <= 0) throw new Error('SESSION_TTL_HOURS inválido.');
  db = adaptDatabase(db);
  const transaction = (_db, fn) => db.transaction(fn);
  const routes = [], buckets = new Map();
  const get = (sql,...args) => db.get(sql,...args);
  const all = (sql,...args) => db.all(sql,...args);
  const run = (sql,...args) => db.run(sql,...args);
  const route = (method,path,handler,isPublic=false) => {
    const keys=[];
    const pattern = new RegExp('^'+path.replace(/:([a-zA-Z]+)/g,(_,k)=>{keys.push(k);return '(\\d+)';})+'/?$');
    routes.push({method,path,pattern,keys,handler,isPublic});
  };
  const visible = (owner,userId) => owner === null || owner === userId;
  async function source(id,userId,own=false) {
    const s=(await get('SELECT id,name,kind,owner_user_id AS ownerUserId,reference FROM sources WHERE id=?',id));
    if (!s || !visible(s.ownerUserId,userId)) fail(404,'NOT_FOUND','Origem não encontrada.');
    if (own && s.ownerUserId!==userId) fail(403,'FORBIDDEN','Use uma origem sua.');
    return s;
  }
  async function character(id,userId) {
    const c=(await get(`SELECT c.id,c.name,c.level,c.class_id AS classId,cl.name AS class,
     c.user_id AS userId,c.created_at AS createdAt FROM characters c
     JOIN classes cl ON cl.id=c.class_id WHERE c.id=? AND c.user_id=?`,id,userId));
    if(!c) fail(404,'NOT_FOUND','Personagem não encontrado.'); return c;
  }
  async function classRecord(id,userId) {
    const c=(await get('SELECT id,name,source_id AS sourceId FROM classes WHERE id=?',id));
    if(!c) fail(404,'NOT_FOUND','Classe não encontrada.');(await source(c.sourceId,userId));return c;
  }
  async function spell(id,userId) {
    const s=(await get(detailSelect+' WHERE s.id=?',id));
    if(!s || !visible(s.ownerUserId,userId)) fail(404,'NOT_FOUND','Magia não encontrada.');
    s.classes=(await all(`SELECT cl.id,cl.name,cl.source_id AS sourceId FROM class_spells cs
     JOIN classes cl ON cl.id=cs.class_id JOIN sources ls ON ls.id=cs.source_id
     JOIN sources cls ON cls.id=cl.source_id WHERE cs.spell_id=?
     AND (ls.owner_user_id IS NULL OR ls.owner_user_id=?)
     AND (cls.owner_user_id IS NULL OR cls.owner_user_id=?) GROUP BY cl.id,cl.name,cl.source_id,cl.search_name ORDER BY cl.search_name,cl.id`,id,userId,userId));
    return s;
  }
  async function homebrewSource(userId) {
    const existing=(await get("SELECT id FROM sources WHERE kind='homebrew' AND owner_user_id=? ORDER BY id LIMIT 1",userId));
    return existing?.id ?? Number((await run("INSERT INTO sources(name,kind,owner_user_id) VALUES('Meus homebrews','homebrew',?)",userId)).lastInsertRowid);
  }
  async function resolveLink(c,spellId,userId) {
    return (await get(`SELECT cs.id FROM class_spells cs JOIN sources ls ON ls.id=cs.source_id
     JOIN spells s ON s.id=cs.spell_id JOIN sources ss ON ss.id=s.source_id
     JOIN classes cl ON cl.id=cs.class_id JOIN sources cls ON cls.id=cl.source_id
     WHERE cs.class_id=? AND cs.spell_id=?
     AND (ls.owner_user_id IS NULL OR ls.owner_user_id=?)
     AND (ss.owner_user_id IS NULL OR ss.owner_user_id=?)
     AND (cls.owner_user_id IS NULL OR cls.owner_user_id=?)
     ORDER BY (ls.owner_user_id IS NOT NULL),cs.id LIMIT 1`,c.classId,spellId,userId,userId,userId));
  }
  async function validateSpell(body,partial=false) {
    const result={};
    for(const field of spellFields) {
      if(partial && body[field]===undefined)continue;
      if(field==='imagePath') {
        const v=body[field] ?? null;
        if(v!==null && (typeof v!=='string' || v.length>2000 || !/^(\/images\/[a-zA-Z0-9_./-]+|https:\/\/[^\s]+)$/.test(v) || v.includes('..'))) fail(400,'VALIDATION_ERROR','imagePath deve ser uma URL https ou caminho /images/.');
        result[field]=v;
      } else if(field==='level')result[field]=integer(body[field],field,0,9);
      else if(field==='schoolId') {
        result[field]=integer(body[field],field);
        if(!(await get('SELECT id FROM schools WHERE id=?',result[field])))fail(400,'VALIDATION_ERROR','Escola inválida.');
      } else result[field]=string(body[field],field,field==='description'?120000:field==='name'?200:8000,false);
    }
    if(!Object.keys(result).length)fail(400,'VALIDATION_ERROR','Informe ao menos um campo para editar.');
    return result;
  }
  const userView = u => ({id:u.id,name:u.name,email:u.email});
  route('GET','/api/health',async ()=>({data:{status:'ok',database:(await db.version())}}),true);
  route('POST','/api/auth/register',async({body})=>{
    object(body,['name','email','password']);
    const name=string(body.name,'name'),address=email(body.email),pass=password(body.password);
    const hash=await hashPassword(pass);
    return (await transaction(db,async ()=>{
      if((await get('SELECT id FROM users WHERE email=?',address)))fail(409,'EMAIL_IN_USE','Email já cadastrado.');
      const id=Number((await run('INSERT INTO users(name,email,password_hash) VALUES(?,?,?)',name,address,hash)).lastInsertRowid);
      const session=(await createSession(db,id,sessionTtlHours));
      return {status:201,data:{user:{id,name,email:address},...session}};
    }));
  },true);
  // Um hash válido também é verificado quando a conta não existe.
  let dummyHash;
  route('POST','/api/auth/login',async({body})=>{
    object(body,['email','password']);const address=email(body.email),pass=string(body.password,'password',256,false);
    const u=(await get('SELECT * FROM users WHERE email=?',address));
    dummyHash ??= hashPassword('senha-ficticia-para-tempo-de-verificacao');
    const valid=await verifyPassword(pass,u?.password_hash ?? await dummyHash);
    if(!u || !valid)fail(401,'INVALID_CREDENTIALS','Email ou senha inválidos.');
    return {data:{user:userView(u),...(await createSession(db,u.id,sessionTtlHours))}};
  },true);
  route('GET','/api/auth/me',async ({user})=>({data:userView(user)}));
  route('POST','/api/auth/logout',async ({session})=>{(await run('DELETE FROM sessions WHERE token_hash=?',session));return {status:204};});
  route('GET','/api/schools',async ()=>({data:(await all('SELECT id,name FROM schools ORDER BY name'))}));
  route('GET','/api/sources',async ({user})=>({data:(await all('SELECT id,name,kind,owner_user_id AS ownerUserId,reference FROM sources WHERE owner_user_id IS NULL OR owner_user_id=? ORDER BY name,id',user.id))}));
  route('POST','/api/sources',async ({body,user})=>{
    object(body,['name','kind','reference']);const name=string(body.name,'name');
    if(!['homebrew','compendium'].includes(body.kind))fail(400,'VALIDATION_ERROR','kind deve ser homebrew ou compendium.');
    const reference=body.reference==null?null:string(body.reference,'reference',2000);
    const id=Number((await run('INSERT INTO sources(name,kind,owner_user_id,reference) VALUES(?,?,?,?)',name,body.kind,user.id,reference)).lastInsertRowid);
    return {status:201,data:(await source(id,user.id))};
  });
  route('GET','/api/classes',async ({user})=>({data:(await all(`SELECT cl.id,cl.name,cl.source_id AS sourceId,src.name AS source,src.kind AS sourceKind
   FROM classes cl JOIN sources src ON src.id=cl.source_id
   WHERE src.owner_user_id IS NULL OR src.owner_user_id=? ORDER BY cl.search_name,cl.id`,user.id))}));
  route('POST','/api/classes',async ({body,user})=>{
    object(body,['name','sourceId']);const name=string(body.name,'name');
    return (await transaction(db,async ()=>{
      const sourceId=body.sourceId===undefined?(await homebrewSource(user.id)):integer(body.sourceId,'sourceId');(await source(sourceId,user.id,true));
      const id=Number((await run('INSERT INTO classes(name,search_name,source_id) VALUES(?,?,?)',name,normalize(name),sourceId)).lastInsertRowid);
      return {status:201,data:(await classRecord(id,user.id))};
    }));
  });
  route('POST','/api/classes/:id/spells',async ({params,body,user})=>{
    object(body,['spellId','sourceId']);(await classRecord(params.id,user.id));const spellId=integer(body.spellId,'spellId');(await spell(spellId,user.id));
    return (await transaction(db,async ()=>{
      const sourceId=body.sourceId===undefined?(await homebrewSource(user.id)):integer(body.sourceId,'sourceId');(await source(sourceId,user.id,true));
      const existing=(await get('SELECT id FROM class_spells WHERE class_id=? AND spell_id=? AND source_id=?',params.id,spellId,sourceId));
      const id=existing?.id ?? Number((await run('INSERT INTO class_spells(class_id,spell_id,source_id) VALUES(?,?,?)',params.id,spellId,sourceId)).lastInsertRowid);
      return {status:existing?200:201,data:{id,classId:params.id,spellId,sourceId}};
    }));
  });
  route('GET','/api/characters',async ({user})=>({data:(await all(`SELECT c.id,c.name,c.level,c.class_id AS classId,cl.name AS class,c.created_at AS createdAt,
   (SELECT COUNT(*) FROM prepared_spells p WHERE p.character_id=c.id) AS preparedCount
   FROM characters c JOIN classes cl ON cl.id=c.class_id WHERE c.user_id=? ORDER BY c.id`,user.id))}));
  route('POST','/api/characters',async ({body,user})=>{
    object(body,['name','classId','level']);const name=string(body.name,'name'),classId=integer(body.classId,'classId'),level=body.level===undefined?1:integer(body.level,'level',1,20);
    (await classRecord(classId,user.id));
    const id=Number((await run('INSERT INTO characters(name,user_id,class_id,level) VALUES(?,?,?,?)',name,user.id,classId,level)).lastInsertRowid);
    return {status:201,data:(await character(id,user.id))};
  });
  route('GET','/api/characters/:id',async ({params,user})=>({data:(await character(params.id,user.id))}));
  route('PATCH','/api/characters/:id',async ({params,body,user})=>{
    object(body,['name','classId','level','clearPrepared']);const c=(await character(params.id,user.id));
    if(!['name','classId','level'].some(k=>body[k]!==undefined))fail(400,'VALIDATION_ERROR','Informe um campo do personagem.');
    if(body.clearPrepared!==undefined && typeof body.clearPrepared!=='boolean')fail(400,'VALIDATION_ERROR','clearPrepared deve ser booleano.');
    const name=body.name===undefined?c.name:string(body.name,'name'),level=body.level===undefined?c.level:integer(body.level,'level',1,20),classId=body.classId===undefined?c.classId:integer(body.classId,'classId');
    (await classRecord(classId,user.id));
    return (await transaction(db,async ()=>{
      const changing=classId!==c.classId;
      if(changing && (await get('SELECT 1 FROM prepared_spells WHERE character_id=?',c.id)) && body.clearPrepared!==true)fail(409,'PREPARED_SPELLS_EXIST','Confirme clearPrepared=true para trocar a classe e limpar as preparadas.');
      if(changing && body.clearPrepared===true)(await run('DELETE FROM prepared_spells WHERE character_id=?',c.id));
      (await run('UPDATE characters SET name=?,level=?,class_id=? WHERE id=?',name,level,classId,c.id));
      return {data:(await character(c.id,user.id))};
    }));
  });
  route('DELETE','/api/characters/:id',async ({params,user})=>{(await character(params.id,user.id));(await run('DELETE FROM characters WHERE id=?',params.id));return {status:204};});
  route('GET','/api/spells',async ({query,user})=>{
    const allowed=['name','schoolId','classId','characterId','level','limit','offset'];
    for(const key of query.keys())if(!allowed.includes(key))fail(400,'VALIDATION_ERROR',`Filtro desconhecido: ${key}.`);
    const name=query.get('name')??'';if(name.length>200)fail(400,'VALIDATION_ERROR','Busca muito longa.');
    const limit=query.has('limit')?queryInteger(query.get('limit'),'limit',1,500):100;
    const offset=query.has('offset')?queryInteger(query.get('offset'),'offset',0):0;
    let where=' WHERE (src.owner_user_id IS NULL OR src.owner_user_id=?) AND s.search_name LIKE ? ESCAPE \'\\\'';
    const args=[user.id,'%'+normalize(name).replace(/[\\%_]/g,'\\$&')+'%'];
    if(query.has('schoolId')){where+=' AND s.school_id=?';args.push(queryInteger(query.get('schoolId'),'schoolId'));}
    if(query.has('level')){where+=' AND s.level=?';args.push(queryInteger(query.get('level'),'level',0,9));}
    if(query.has('classId')){
      const classId=queryInteger(query.get('classId'),'classId');(await classRecord(classId,user.id));
      where+=` AND EXISTS(SELECT 1 FROM class_spells cs JOIN sources ls ON ls.id=cs.source_id
       WHERE cs.spell_id=s.id AND cs.class_id=? AND (ls.owner_user_id IS NULL OR ls.owner_user_id=?))`;
      args.push(classId,user.id);
    }
    const total=(await get('SELECT COUNT(*) AS n FROM spells s JOIN sources src ON src.id=s.source_id'+where,...args)).n;
    const data=(await all(summarySelect+where+' ORDER BY s.level,s.search_name,s.id LIMIT ? OFFSET ?',...args,limit,offset));
    if(query.has('characterId')){
      const c=(await character(queryInteger(query.get('characterId'),'characterId'),user.id));
      const prepared=new Set((await all('SELECT cs.spell_id AS id FROM prepared_spells p JOIN class_spells cs ON cs.id=p.class_spell_id WHERE p.character_id=?',c.id)).map(s=>s.id));
      for(const s of data){s.canPrepare=!!(await resolveLink(c,s.id,user.id));s.isPrepared=prepared.has(s.id);}
    }
    return {data,meta:{total,limit,offset}};
  });
  route('GET','/api/spells/:id',async ({params,user})=>({data:(await spell(params.id,user.id))}));
  route('POST','/api/spells',async ({body,user})=>{
    object(body,[...spellFields,'classIds']);const values=(await validateSpell(body)),classIds=body.classIds===undefined?[]:ids(body.classIds);
    for(const id of classIds)(await classRecord(id,user.id));
    return (await transaction(db,async ()=>{
      const sourceId=(await homebrewSource(user.id));
      const fields=Object.keys(values),names=fields.map(k=>columns[k]);
      const id=Number((await run(`INSERT INTO spells(${names.join(',')},search_name,source_id) VALUES(${fields.map(()=>'?').join(',')},?,?)`,...fields.map(k=>values[k]),normalize(values.name),sourceId)).lastInsertRowid);
      for(const classId of classIds)(await run('INSERT INTO class_spells(class_id,spell_id,source_id) VALUES(?,?,?)',classId,id,sourceId));
      return {status:201,data:(await spell(id,user.id))};
    }));
  });
  route('PATCH','/api/spells/:id',async ({params,body,user})=>{
    object(body,spellFields);const s=(await spell(params.id,user.id));
    if(s.ownerUserId!==user.id || s.sourceKind!=='homebrew')fail(403,'FORBIDDEN','Só é permitido editar uma magia homebrew sua.');
    const values=(await validateSpell(body,true)),fields=Object.keys(values);
    const updates=fields.map(k=>columns[k]+'=?'),args=fields.map(k=>values[k]);
    if(values.name!==undefined){updates.push('search_name=?');args.push(normalize(values.name));}
    updates.push('updated_at=?');args.push(new Date().toISOString());
    (await run(`UPDATE spells SET ${updates.join(',')} WHERE id=?`,...args,s.id));
    return {data:(await spell(s.id,user.id))};
  });
  route('GET','/api/characters/:id/prepared-spells',async ({params,user})=>{
    (await character(params.id,user.id));
    const data=(await all(detailSelect.replace(' FROM spells s', ', p.prepared_at AS preparedAt FROM spells s')+` JOIN class_spells cs ON cs.spell_id=s.id JOIN prepared_spells p ON p.class_spell_id=cs.id
     WHERE p.character_id=? ORDER BY s.level,s.search_name,s.id`,params.id));
    return {data};
  });
  route('PUT','/api/characters/:id/prepared-spells/:spellId',async ({params,user,body})=>{
    object(body,[]);const c=(await character(params.id,user.id));(await spell(params.spellId,user.id));
    return (await transaction(db,async ()=>{
      const existing=(await get(`SELECT 1 FROM prepared_spells p JOIN class_spells cs ON cs.id=p.class_spell_id WHERE p.character_id=? AND cs.spell_id=?`,c.id,params.spellId));
      if(!existing){const link=(await resolveLink(c,params.spellId,user.id));if(!link)fail(422,'SPELL_NOT_ELIGIBLE','Esta magia não pertence à lista acessível da classe do personagem.');(await run('INSERT INTO prepared_spells(character_id,class_spell_id) VALUES(?,?)',c.id,link.id));}
      return {data:(await spell(params.spellId,user.id))};
    }));
  });
  route('DELETE','/api/characters/:id/prepared-spells/:spellId',async ({params,user})=>{
    (await character(params.id,user.id));
    (await run('DELETE FROM prepared_spells WHERE character_id=? AND class_spell_id IN (SELECT id FROM class_spells WHERE spell_id=?)',params.id,params.spellId));
    return {status:204};
  });

  const server=createServer(async(req,res)=>{
    const requestId=randomUUID(),started=performance.now();
    let routePath='[unmatched]',responseCode,userId,internalError,logged=false;
    res.setHeader('X-Request-Id',requestId);
    const writeLog=(status)=>{
      if(logged || status<400)return;
      logged=true;
      const level=status>=500?'error':'warn';
      const safeCode=value=>typeof value==='string' && /^[A-Z0-9_]{1,64}$/.test(value)?value:undefined;
      const entry={timestamp:new Date().toISOString(),level,event:'http_request_failed',requestId,
        method:req.method,route:routePath,status,code:safeCode(responseCode),userId,
        durationMs:Math.round(performance.now()-started)};
      if(internalError)entry.error={type:/^[A-Za-z]{1,64}$/.test(internalError.name??'')?internalError.name:'Error',code:safeCode(internalError.code)};
      // Não inclui corpo, query string, headers ou mensagens brutas do driver.
      try{logger[level]?.(JSON.stringify(entry));}catch{/* Falha do logger não altera a resposta HTTP. */}
    };
    res.once('finish',()=>writeLog(res.statusCode));
    res.once('close',()=>{if(!res.writableFinished){responseCode='REQUEST_ABORTED';writeLog(499);}});
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Cache-Control','no-store');
    const send=(status,payload)=>{
      responseCode=payload?.error?.code;
      res.statusCode=status;if(status===204){res.end();return;}
      res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify(payload));
    };
    try {
      const url=new URL(req.url,'http://localhost');
      const candidates=routes.filter(r=>r.pattern.test(url.pathname));
      const found=candidates.find(r=>r.method===req.method);
      routePath=found?.path ?? candidates[0]?.path ?? '[unmatched]';
      const origin=req.headers.origin;
      if(origin){if(!corsOrigins.includes(origin))fail(403,'CORS_FORBIDDEN','Origem não autorizada.');res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');}
      if(req.method==='OPTIONS'){
        res.setHeader('Access-Control-Allow-Methods','GET,POST,PATCH,PUT,DELETE,OPTIONS');res.setHeader('Access-Control-Allow-Headers','Authorization,Content-Type');res.setHeader('Access-Control-Max-Age','600');send(204);return;
      }
      if(!found){if(candidates.length){res.setHeader('Allow',candidates.map(r=>r.method).join(', '));fail(405,'METHOD_NOT_ALLOWED','Método não permitido.');}fail(404,'NOT_FOUND','Rota não encontrada.');}
      const match=url.pathname.match(found.pattern),params={};found.keys.forEach((k,i)=>params[k]=queryInteger(match[i+1],k));
      let user,session;
      if(!found.isPublic){
        const token=req.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
        if(!token)fail(401,'UNAUTHENTICATED','Informe um token Bearer válido.');
        session=tokenHash(token);
        user=(await get(`SELECT u.id,u.name,u.email FROM users u JOIN sessions ses ON ses.user_id=u.id WHERE ses.token_hash=? AND ses.expires_at>?`,session,Date.now()));
        if(!user)fail(401,'UNAUTHENTICATED','Sessão inválida ou expirada.');
        userId=user.id;
      }
      if(url.pathname==='/api/auth/login' || url.pathname==='/api/auth/register'){
        const now=Date.now();for(const [k,v] of buckets)if(v.until<=now)buckets.delete(k);
        const key=req.socket.remoteAddress??'local';
        const bucket=buckets.get(key)??{n:0,until:now+900000};
        if(bucket.n>=authLimit){res.setHeader('Retry-After',String(Math.ceil((bucket.until-now)/1000)));fail(429,'RATE_LIMITED','Muitas tentativas. Tente novamente mais tarde.');}
        bucket.n++;buckets.set(key,bucket);
      }
      let body={};
      if(['POST','PUT','PATCH'].includes(req.method)){
        let size=0,tooLarge=false;const chunks=[];
        for await(const chunk of req){size+=chunk.length;if(size>256*1024){tooLarge=true;chunks.length=0;}else if(!tooLarge)chunks.push(chunk);}
        if(tooLarge)fail(413,'BODY_TOO_LARGE','Corpo da requisição excede 256 KiB.');
        if(size){if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']??''))fail(415,'UNSUPPORTED_MEDIA_TYPE','Use Content-Type: application/json.');
          try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail(400,'INVALID_JSON','JSON inválido.');}
        }
      }
      const result=await found.handler({body,params,query:url.searchParams,user,session});
      const {status=200,...payload}=result;send(status,payload);
    }catch(error){
      if(error instanceof HttpError){send(error.status,{error:{code:error.code,message:error.message}});return;}
      if(error.code==='23505' || (error.code?.startsWith('ERR_SQLITE') && /UNIQUE constraint failed/.test(error.message))){send(409,{error:{code:'CONFLICT',message:'Já existe um registro com esses dados nesta origem.'}});return;}
      if(['23503','23514','P0001'].includes(error.code) || (error.code?.startsWith('ERR_SQLITE') && /constraint failed|Magia|Desprepare|imutável/.test(error.message))){send(409,{error:{code:'CONSTRAINT_VIOLATION',message:'A operação viola uma regra do banco.'}});return;}
      internalError=error;send(500,{error:{code:'INTERNAL_ERROR',message:'Erro interno do servidor.'}});
    }
  });
  server.requestTimeout=30000;server.headersTimeout=15000;
  return server;
}
