import test from 'node:test';
import assert from 'node:assert/strict';
import {newProject,newProjectFromPoster,backgroundChoices} from '../src/new-project.js';
const previous={archiveCampaignId:'old',campaign:{name:'Old',start:'2026-01-01',end:'2026-01-02',stores:'Old store'},nodes:[{id:'old',price:'20'}],products:[{id:'rice',name:'Rice',aliases:['rice'],imageUrl:'data:image/png;base64,eA=='}],page:{width:500,height:500},cutoutPending:{id:'old'},reviewedRevision:7,parentArchiveId:'old'};
test('new project starts with a distinct campaign and empty editable content',()=>{
 const n=newProject(previous,{name:'New sale',template:'retail'});assert.notEqual(n.archiveCampaignId,previous.archiveCampaignId);assert.equal(n.campaign.name,'New sale');assert.equal(n.campaign.start,'');assert.equal(n.campaign.stores,'');assert.deepEqual(n.nodes,[]);assert.equal(n.step,1);assert.equal(n.revision,1);assert.equal(n.status,'draft');assert.equal(n.cutoutPending,undefined);assert.equal(n.parentArchiveId,undefined);assert.equal(n.page,undefined);assert.deepEqual(n.retailRows,[3,3,4]);
});
test('reusing the library never copies old canvas or mutates original assets',()=>{const n=newProject(previous);n.products[0].name='Edited';n.products[0].aliases.push('new');assert.equal(previous.products[0].name,'Rice');assert.deepEqual(previous.products[0].aliases,['rice']);assert.deepEqual(n.nodes,[]);});
test('new project can start without any old assets',()=>{const n=newProject(previous,{keepAssets:false});assert.deepEqual(n.products,[]);assert.deepEqual(n.icons,[]);assert.notEqual(newProject(previous).archiveCampaignId,n.archiveCampaignId);assert.throws(()=>newProject(previous,{template:'unknown'}));});

test('poster upload creates an isolated activity in activity setup, retaining only library assets',()=>{
 const asset={id:'poster',name:'old-poster.png',imageUrl:'data:image/png;base64,eA=='};
 const n=newProjectFromPoster(previous,asset,{width:1800,height:2560});
 assert.notEqual(n.archiveCampaignId,previous.archiveCampaignId);
 assert.equal(n.step,1);assert.equal(n.flowVersion,2);assert.equal(n.template,'custom');assert.equal(n.background,asset.imageUrl);
 assert.deepEqual(n.nodes,[]);assert.equal(n.campaign.start,'');assert.equal(n.campaign.stores,'');
 assert.equal(n.posterReuse.prepared,false);assert.equal(n.posterReuse.mode,'replace');
 assert.deepEqual(n.posterReuse.masks,[]);assert.equal(previous.nodes.length,1);
 assert.equal(n.products[0].id,'rice');assert.equal(n.page.width,1800);
 assert.throws(()=>newProjectFromPoster(previous,asset,{width:0,height:100}));
});

test('selecting an uploaded PDF background reuses it without duplication and respects library preference',()=>{
 const asset={id:'pdf-page',name:'poster - 第1頁.png',imageUrl:'data:image/png;base64,eA=='};
 const old={...previous,backgrounds:[asset]};
 const n=newProjectFromPoster(old,asset,{width:2000,height:3000},{name:'Next sale',keepAssets:true});
 assert.equal(n.backgrounds.length,1);assert.equal(n.campaign.name,'Next sale');assert.equal(n.step,1);assert.deepEqual(n.nodes,[]);
 const empty=newProjectFromPoster(old,asset,{width:2000,height:3000},{keepAssets:false});
 assert.deepEqual(empty.products,[]);assert.equal(empty.backgrounds.length,1);assert.equal(empty.background,asset.imageUrl);
});

test('duplicate PDF content has one choice and repeated upload reuses its id',()=>{
 const a={id:'first',name:'poster.png',imageUrl:'data:image/png;base64,YQ=='};
 const duplicate={...a,id:'second'},different={...a,id:'third',imageUrl:'data:image/png;base64,Yg=='};
 const choices=backgroundChoices([a,duplicate,different]);assert.equal(choices.length,2);assert.notEqual(choices[0].label,choices[1].label);
 const p=newProjectFromPoster({...previous,backgrounds:[a,duplicate]}, {...a,id:'new-upload'}, {width:1000,height:1400});
 assert.equal(p.backgrounds.length,1);assert.equal(p.backgroundId,'first');assert.equal(p.step,1);
});
