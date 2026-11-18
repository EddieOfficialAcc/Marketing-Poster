import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../src/app.js',import.meta.url),'utf8');
const removeFunction=source.slice(source.indexOf('function deleteNodes('),source.indexOf("$('#step-products').addEventListener"));
const selectionFunction=source.slice(source.indexOf('function deleteSelection(){'),source.indexOf("$('#delete-selected').addEventListener"));
for(const selection of ['product',null])test(`delete entire product with ${selection?'text/picture selection':'editor-only selection'}`,()=>{
 const removed=[],context={project:{nodes:[{id:'product',type:'product',pictures:[{id:'one'},{id:'two'}]},{id:'other'}],products:[{id:'source'}]},selected:selection,selectedPicture:'one',pictureSelectionExplicit:true,editingRegion:true,focusField:'price',
 finishDrag(){},fabricEditor:{stopDragging(){},remove(ids){removed.push(...ids);},selectedIds:()=>['product']},edited(){},renderProperties(){},toast(){}};
 vm.createContext(context);vm.runInContext(removeFunction+'\n'+selectionFunction,context);context.deleteSelection();
 assert.equal(context.project.nodes.length,1);assert.equal(context.project.nodes[0].id,'other');assert.equal(context.project.products.length,1);assert.deepEqual(removed,['product']);assert.equal(context.editingRegion,false);assert.equal(context.selected,null);
});
