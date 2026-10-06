import { resolve } from 'node:path';
import { openDatabase, root } from './database.js';
import { createApp } from './app.js';
import { sqliteAdapter } from './db-adapter.js';
const port=Number(process.env.PORT??3000),host=process.env.HOST??'0.0.0.0';
if(!Number.isInteger(port) || port<1 || port>65535)throw new Error('PORT inválido.');
if (process.env.NODE_ENV === 'production' && !process.env.DATABASE_URL) throw new Error('DATABASE_URL é obrigatória em produção.');
if (process.env.NODE_ENV === 'production' && !process.env.CORS_ORIGINS) throw new Error('CORS_ORIGINS é obrigatória em produção.');
const db=process.env.DATABASE_URL
  ? await (await import('./postgres.js')).openPostgres()
  : sqliteAdapter(openDatabase(resolve(root,process.env.DATABASE_PATH??'data/magias.sqlite')));
const server=createApp({db,corsOrigins:(process.env.CORS_ORIGINS??'http://localhost:5173,http://127.0.0.1:5173').split(',').map(s=>s.trim()).filter(Boolean),sessionTtlHours:Number(process.env.SESSION_TTL_HOURS??168)});
server.listen(port,host,()=>console.log(`API pronta em http://${host}:${port}/api/health`));
let stopping=false;
function stop(){if(stopping)return;stopping=true;server.close(async()=>{await db.close();process.exit(0);});server.closeIdleConnections();setTimeout(()=>{server.closeAllConnections();},5000).unref();}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
server.on('error',async error=>{console.error(error.message);await db.close();process.exitCode=1;});
