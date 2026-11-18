import vm from 'node:vm';
import fs from 'node:fs/promises';
import path from 'node:path';
import {webcrypto} from 'node:crypto';
const root=path.resolve('src'),listeners=new Map(),elements=new Map();
class Element {
 constructor(key=''){this.key=key;this.style={setProperty(name,value){this[name]=value;}};this.dataset={};this.value='';this.hidden=false;this.checked=false;this.disabled=false;this.width=900;this.height=1280;this.clientWidth=900;this.options=[];this.classList={add(){},remove(){},toggle(){}};}
 addEventListener(event,handler){listeners.set(`${this.key}:${event}`,handler);}
 insertAdjacentHTML(position,html){this.innerHTML=(this.innerHTML||'')+html;}
 setAttribute(){} removeAttribute(){} append(){} prepend(){} replaceChildren(){} scrollIntoView(){} focus(){}
 querySelector(s){return element(`${this.key} ${s}`);}querySelectorAll(){return [];}
 getContext(){return {measureText:t=>({width:String(t).length*10}),save(){},restore(){}};}
 closest(){return this;}
}
function element(key){if(['#export-mode','#pdf-bleed'].includes(key))throw new Error(`Removed control referenced: ${key}`);if(!elements.has(key))elements.set(key,new Element(key));return elements.get(key);}
const context=vm.createContext({console,crypto:webcrypto,structuredClone,URL,AbortSignal,TextEncoder,TextDecoder,confirm:()=>true,
 document:{querySelector:element,querySelectorAll:()=>[],createElement:tag=>new Element(tag),body:new Element('body'),addEventListener(){}},
 window:{addEventListener(){},posterUser:{username:'test'}},Option:class extends Element{},
 setTimeout:()=>1,clearTimeout(){},setInterval:()=>1,clearInterval(){},requestAnimationFrame:()=>1,fetch:async()=>{throw new Error('Unexpected network during startup');},
});
const modules=new Map();
async function moduleAt(filename){
 if(modules.has(filename))return modules.get(filename);
 let source=await fs.readFile(filename,'utf8');
 if(filename.endsWith('/app.js')&&process.env.STARTUP_SOURCE)source=await fs.readFile(process.env.STARTUP_SOURCE,'utf8');
 // Replace browser/network boundaries, retaining actual app, UI and rendering logic.
 if(filename.endsWith('/fabric-editor.js'))source='export async function createFabricEditor(){return {update(){},stopDragging(){},setDisplayScale(){},selectedIds(){return [];}};}';
 if(filename.endsWith('/products.js'))source=source.replace('export async function loadProject() {','export async function loadProject() { return null;');
 if(filename.endsWith('/archive.js'))source=source.replace(' const snapshot=structuredClone(project);',' if(globalThis.smokeArchive)return globalThis.smokeArchive(project);\n const snapshot=structuredClone(project);');
 if(filename.endsWith('/catalog.js'))source=source.replace('export async function seedCatalog(project) {','export async function seedCatalog(project) { return 0;');
 if(filename.endsWith('/app.js'))source+='\nexport {project as smokeProject, selected as smokeSelected, renderSteps as smokeRenderSteps,renderArchiveList as smokeArchiveList}; export function smokePreview(){generatedPoster={snapshot:structuredClone(project),revision:project.revision,blob:null};confirmedArchive=null;project.reviewedRevision=null;renderSteps();}';
 const module=new vm.SourceTextModule(source,{context,identifier:filename});modules.set(filename,module);return module;
}
const entry=await moduleAt(path.join(root,'app.js'));
await entry.link((specifier,parent)=>moduleAt(path.resolve(path.dirname(parent.identifier),specifier)));
await entry.evaluate();
for(const name of ['#batch-cutout:click','#open-poster-auto:click','#pdf-original:click']){
 if(!listeners.has(name))throw new Error(`Startup did not register ${name}`);
}
if(!elements.get('#engine-status')?.textContent?.includes('Fabric'))throw new Error('Editor did not finish initialization');
console.log('App startup completed; editor and late action handlers are ready.');

// A product chosen on the output screen must open its editable properties.
const project=entry.namespace.smokeProject;
project.campaign={name:'核對活動',start:'2026-11-01',end:'2026-11-30',stores:'全線'};
project.products=[{id:'asset',name:'商品',sku:'A1',spec:'1kg'}];
const model=modules.get(path.join(root,'model.js'));
const node=model.namespace.productNode(project.products[0]);node.price='20';
project.nodes=[node];project.flowVersion=2;project.step=3;
entry.namespace.smokeRenderSteps();
listeners.get('#step-products:click')({target:{closest(selector){return selector==='[data-review-node]'?{dataset:{reviewNode:node.id}}:null;}}});
if(project.step!==2||entry.namespace.smokeSelected!==node.id)throw new Error('Product review did not navigate to selected product');
if(elements.get('.studio').hidden)throw new Error('Product editor is still hidden');
console.log('Product review opens the selected product from the output screen.');

// Exercise the actual confirmation handler against a pending server request.
project.step=3;entry.namespace.smokePreview();
const checkbox=element('#review-confirmed');
if(checkbox.disabled)throw new Error('Current preview cannot be confirmed');
let finishConfirmation;
context.smokeArchive=()=>new Promise(resolve=>{finishConfirmation=resolve;});
checkbox.checked=true;
const saving=listeners.get('#review-confirmed:change')({target:checkbox});
if(!checkbox.checked||!checkbox.disabled)throw new Error('Pending confirmation must remain checked and prevent duplicate saves');
finishConfirmation({revision:project.revision,sequence:1,created_at:new Date().toISOString()});
await saving;
if(!checkbox.checked||checkbox.disabled||element('#download-poster').disabled)throw new Error('Confirmed preview should remain checked and enable download');
entry.namespace.smokePreview();context.smokeArchive=async()=>{throw new Error('Archive unavailable');};
checkbox.checked=true;await listeners.get('#review-confirmed:change')({target:checkbox});
if(checkbox.checked||checkbox.disabled)throw new Error('Failed confirmation must allow retry without claiming success');
if(!element('#output-status').textContent.includes('Archive unavailable'))throw new Error('Save failure must be visible');
project.revision++;entry.namespace.smokeRenderSteps();
if(!checkbox.disabled)throw new Error('Stale preview cannot be confirmed');
console.log('Confirmation stays checked during save, enables downloads on success, and permits retry on failure.');

// A failed archive must leave the original project available and release the dialog.
element('#new-project-template').value='clean';
element('#new-project-name').value='New campaign';
element('#new-project-keep-assets').checked=true;
context.smokeArchive=async()=>{throw new Error('Archive unavailable');};
await listeners.get('#new-project-form:submit')({preventDefault(){}});
if(entry.namespace.smokeProject!==project)throw new Error('Failed save replaced the original project');
if(element('#create-new-project').disabled||element('#close-new-project').disabled)throw new Error('Failed new project save leaves dialog stuck');
if(!element('#new-project-status').textContent.includes('Archive unavailable'))throw new Error('New project failure is not visible');
console.log('New project failure preserves the original and releases retry/close controls.');

// Older list responses must never replace a newer refresh.
const pendingLists=[];
context.fetch=()=>new Promise(resolve=>pendingLists.push(resolve));
const oldList=entry.namespace.smokeArchiveList(true);
const newList=entry.namespace.smokeArchiveList(true);
const version={id:'test-version',name:'New list',sequence:1,revision:1,created_at:new Date().toISOString()};
pendingLists[1]({ok:true,json:async()=>[version]});await newList;
pendingLists[0]({ok:true,json:async()=>[{...version,name:'Stale list'}]});await oldList;
if(!element('#archive-list').innerHTML.includes('New list')||element('#archive-list').innerHTML.includes('Stale list'))throw new Error('Old archive request overwrote the current list');

// Repeated restore clicks must share no extra writes; failures release the button.
context.fetch=async()=>({ok:true,json:async()=>({version,project:{campaign:project.campaign}})});
await listeners.get('#archive-list:click')({target:{closest:()=>({dataset:{archive:version.id}})}});
let archiveCalls=0,rejectRestore;
context.smokeArchive=()=>{archiveCalls++;return new Promise((resolve,reject)=>{rejectRestore=reject;});};
const restoring=listeners.get('#archive-restore:click')();
await listeners.get('#archive-restore:click')();
await listeners.get('#archive-delete-version:click')();
if(archiveCalls!==1||!element('#archive-restore').disabled)throw new Error('Restore permits duplicate or conflicting actions');
rejectRestore(new Error('Archive offline'));await restoring;
if(element('#archive-restore').disabled||entry.namespace.smokeProject!==project)throw new Error('Failed restore did not retain the project and unlock the button');
console.log('Archive list ignores stale responses; restore prevents repeat clicks and allows retry after failure.');

listeners.get('#show-grid:change')({target:{checked:false}});
if(!element('#poster-grid').hidden)throw new Error('Grid cannot be hidden');
listeners.get('#show-grid:change')({target:{checked:true}});
listeners.get('#grid-density:change')({target:{value:'40'}});
if(element('#poster-grid').hidden||element('#poster-grid').style['--grid-count']!=='40')throw new Error('Grid settings do not update');
console.log('Editor grid can be toggled and density changed without touching project data.');
