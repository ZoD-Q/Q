import { spawnSync } from 'node:child_process';
const cwd=new URL('../',import.meta.url).pathname;
const env={...process.env,VITE_Q_LOCAL_API_TEST:'0',VITE_Q_API_URL:''};
for(const script of ['node_modules/vite/bin/vite.js','scripts/stamp-build.mjs']){
 const args=script.includes('vite.js')?['build']:[];
 const result=spawnSync(process.execPath,[new URL('../'+script,import.meta.url).pathname,...args],{cwd,env,stdio:'inherit'});
 if(result.status!==0)process.exit(result.status??1);
}
