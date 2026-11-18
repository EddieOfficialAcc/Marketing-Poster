import { mkdir, copyFile } from 'node:fs/promises';
await mkdir('vendor/fabric',{recursive:true});
await copyFile('node_modules/fabric/dist/index.min.mjs','vendor/fabric/index.min.js');
await copyFile('node_modules/fabric/LICENSE','vendor/fabric/LICENSE');
console.log('Fabric.js browser bundle prepared locally.');
