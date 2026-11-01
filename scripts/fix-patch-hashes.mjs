
import {createHash} from 'node:crypto';import fs from 'node:fs';
const A='abcdefghijklmnopqrstuvwxyz234567';
const b32=(buf)=>{let bits=0,v=0,o='';for(const b of buf){v=(v<<8)|b;bits+=8;while(bits>=5){o+=A[(v>>>(bits-5))&31];bits-=5;}}if(bits>0)o+=A[(v<<(5-bits))&31];return o};
let lock=fs.readFileSync('pnpm-lock.yaml','utf8');let n=0;
lock=lock.replace(/(    hash: )([a-z2-7]+)(\n    path: )(patches\/[^\n]+)/g,(m,a,h,b,p)=>{const c=fs.readFileSync(p,'utf8').replace(/\r\n/g,'\n');const nh=b32(createHash('md5').update(c).digest());if(nh!==h)n++;return a+nh+b+p});
fs.writeFileSync('pnpm-lock.yaml',lock);console.log('patch hashes updated',n);
