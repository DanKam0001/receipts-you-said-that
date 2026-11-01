import assert from 'node:assert/strict';
import { refineFoundReceipt } from '../src/receipt-refinement.js';
import { DEFAULT_THRESHOLDS, type Candidate, type NliProbabilities } from '../src/matcher.js';
import type { Receipt, Utterance } from '../src/model.js';

const receipt: Receipt={id:'r',outcome:'RECEIPT FOUND',query:'you said this boss is free',requester:'viewer',score:.96,status:'pending'};
function candidate(rows:Utterance[]):Candidate{return {id:'u1-1',startIndex:0,utteranceCount:1,premise:rows.map(r=>r.text).join(' '),retrievalScore:.9,lexicalScore:.8,semanticScore:.9,quote:rows.map(r=>r.text).join(' '),timestamp:rows[0]!.start,quoteEnd:rows.at(-1)!.end,context:'',clipStart:rows[0]!.start,clipEnd:rows.at(-1)!.end,negationConflict:false,utterances:rows,quoteWords:rows.flatMap(r=>r.words??[])};}
function words(text:string,start:number,end:number){const t=text.match(/\S+/g)??[];return t.map((x,i)=>({text:x,start:start+(end-start)*i/t.length,end:start+(end-start)*(i+1)/t.length}));}
async function main(){
 const fragment='one. Honestly This boss is free.';const row={start:0,end:3,text:fragment,words:words(fragment,0,3)};const c=candidate([row]);
 const refined=await refineFoundReceipt(receipt,c,[row],async pairs=>pairs.map(p=>({entailment:p.premise==='Honestly This boss is free.'?.96:.1,contradiction:.01,neutral:.03})),DEFAULT_THRESHOLDS);
 assert.equal(refined.outcome,'RECEIPT FOUND');assert.equal(refined.quote,'Honestly This boss is free.');assert.ok(refined.timestamp!>0.3);assert.ok(refined.clipStart!<refined.timestamp!);
 const long='Earlier setup. The ranked match is free and easy. More commentary follows.';const longRow={start:21.98,end:47.71,text:long,words:words(long,21.98,47.71)};const longCandidate=candidate([longRow]);longCandidate.timestamp=24;longCandidate.quoteEnd=39.8;longCandidate.clipStart=21.98;longCandidate.clipEnd=47.71;
 const short=await refineFoundReceipt({...receipt,query:'you said ranked was easy'},longCandidate,[longRow],async pairs=>pairs.map(p=>({entailment:p.premise==='The ranked match is free and easy.'?.96:.1,contradiction:.01,neutral:.03})),DEFAULT_THRESHOLDS);
 assert.equal(short.outcome,'RECEIPT FOUND');assert.equal(short.quote,'The ranked match is free and easy.');assert.ok(short.clipEnd!-short.clipStart!<=15);assert.ok(short.clipEnd!-short.clipStart!<26);
 const kept=await refineFoundReceipt(receipt,c,[row],async pairs=>pairs.map(()=>({entailment:.1,contradiction:.1,neutral:.8})),DEFAULT_THRESHOLDS);
 assert.equal(kept.outcome,'RECEIPT FOUND');assert.equal(kept.quote,fragment);assert.ok(kept.clipEnd!-kept.clipStart!<=15);
 console.log('ok tight receipt refinement (fragment, long clip cap, no smaller span)');
}
void main().catch(error=>{console.error(error);process.exitCode=1});
