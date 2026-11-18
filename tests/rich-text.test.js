import test from 'node:test';
import assert from 'node:assert/strict';
import {strikeText,strikeStyles,richRuns,textFamily,TEXT_FONTS} from '../src/rich-text.js';

test('strike markup is removed from rendered text and mapped per original line',()=>{
 const r=strikeText('90克 ~~$14~~');assert.equal(r.plain,'90克 $14');assert.deepEqual(r.marks,[false,false,false,false,true,true,true]);
 assert.deepEqual(strikeStyles('樂事\n90克 ~~$14~~'),{1:{4:{linethrough:true},5:{linethrough:true},6:{linethrough:true}}});
 assert.equal(strikeText('無標記').plain,'無標記');
});
test('bold markup marks whole lines and combines with strike-through',()=>{
 const r=strikeText('**樂事**\n90克 ~~$14~~');assert.equal(r.plain,'樂事\n90克 $14');assert.deepEqual(r.bold.slice(0,3),[true,true,false]);
 assert.deepEqual(strikeStyles('**樂事**')[0][1],{fontWeight:700});
 assert.deepEqual(richRuns([...'ab$1'],[false,false,true,true],[true,false,false,false]).map(x=>[x.text,x.bold,x.strike]),[['a',true,false],['b',false,false],['$1',false,true]]);
});
test('recognized poster text uses Arial for Latin glyphs; other layers keep the default font',()=>{
 assert.match(textFamily({textLayout:{font:'poster'}}),/^Arial/);assert.equal(textFamily({}),TEXT_FONTS.default);assert.equal(textFamily({textLayout:{font:'x'}}),TEXT_FONTS.default);
});
