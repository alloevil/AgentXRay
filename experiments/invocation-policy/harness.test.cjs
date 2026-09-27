const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {tasks,materialize}=require('./tasks.cjs');
const {grade,hash,createBench,executeCli}=require('./bench.cjs');
const {outcomes,aggregate,workspaceMetadata}=require('./run.cjs');

test('new task references pass all public and hidden cases; four broken and two correct',async()=>{
  assert.equal(tasks.filter(task=>task.correctInitially).length,2);
  for(const task of tasks){
    assert.equal(grade(process.execPath,task.reference,task.publicCases).passed,true,task.id);
    assert.equal(grade(process.execPath,task.reference,task.hiddenCases).passed,true,task.id);
    assert.equal(grade(process.execPath,task.source,task.publicCases).passed,task.correctInitially,task.id);
    assert.equal(grade(process.execPath,task.source,task.hiddenCases).passed,task.correctInitially,task.id);
    const data=await materialize(task);assert.equal(data.verifiedInitially,task.correctInitially);assert.deepEqual(await materialize(task),data);
    assert.ok(data.log.includes('sourceSha256'));assert.ok(data.log.includes('suiteSha256'));
  }
});

test('evaluator preserves __proto__ own keys and rejects mutations, invalid code and imports',()=>{
  const special=JSON.parse('{"__proto__":{"x":1}}');
  assert.equal(grade(process.execPath,'function solve(input){return input;}',[{input:special,expected:special}]).passed,true);
  assert.equal(grade(process.execPath,'function solve(input){input.sort();return 1;}',[{input:[2,1],expected:1}]).passed,false);
  for(const source of ['invalid syntax!', 'function solve(){return process.env}', 'function solve(){return require("fs")}', 'function solve(){while(true){}}'])assert.equal(grade(process.execPath,source,[{input:1,expected:1}]).passed,false);
});

async function fixture(context,task=tasks[4]){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'axr-policy-selftest-'));context.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const work=path.join(root,'work');fs.mkdirSync(work);const data=await materialize(task);
  fs.writeFileSync(path.join(work,'solution.js'),task.source);fs.writeFileSync(path.join(work,'public-tests.json'),JSON.stringify(task.publicCases));
  fs.writeFileSync(path.join(work,'session.jsonl'),data.log);fs.writeFileSync(path.join(work,'workspace.json'),JSON.stringify(workspaceMetadata(task)));
  return {work,receipt:path.join(root,'receipt.jsonl'),node:process.execPath,arm:'ondemand',verifiedSources:data.evaluations.filter(entry=>entry.passed).map(entry=>entry.sourceSha256),task,data};
}

test('no-tool baseline denies CLI but can read identical history and run public tests',async context=>{
  const spec=await fixture(context);const bench=createBench({...spec,arm:'baseline'});const ctx={abort:()=>{throw Error('Unexpected abort');}};
  const denied=await bench.execute({action:'inspect',view:'summary'},ctx);assert.equal(denied.isError,true);
  const history=await bench.execute({action:'read',file:'session.jsonl'},ctx);assert.equal(JSON.parse(history.content[0].text).content,spec.data.log);
  const passed=await bench.execute({action:'test'},ctx);assert.equal(passed.isError,false);
  const rows=fs.readFileSync(spec.receipt,'utf8').trim().split('\n').map(JSON.parse);assert.equal(rows.find(row=>row.action==='test').redundantTest,true);
});

test('enabled CLI uses actual summary and evidence while refusing path and test writes',async context=>{
  const spec=await fixture(context,tasks[1]);const bench=createBench(spec);const ctx={abort:()=>{throw Error('Unexpected abort');}};
  for(const params of [{action:'read',file:'../hidden.json'},{action:'write',file:'public-tests.json',content:'[]'}])assert.equal((await bench.execute(params,ctx)).isError,true);
  const response=await bench.execute({action:'inspect',view:'summary'},ctx);assert.equal(response.isError,false);const report=JSON.parse(response.content[0].text);assert.equal(report.kind,'summary');
  assert.equal(report.source.sha256,hash(spec.data.log));
  const evidence=await bench.execute({action:'evidence',sha256:report.source.sha256,line:2,maxBytes:32},ctx);assert.equal(evidence.isError,false);assert.equal(JSON.parse(evidence.content[0].text).returnedBytes,32);
  const direct=executeCli(process.execPath,path.join(spec.work,'session.jsonl'),{action:'inspect',view:'summary'});assert.equal(direct.text,response.content[0].text);
});

test('new source invalidates old verification; tests record exact hashes and repeats',async context=>{
  const spec=await fixture(context,tasks[2]);const bench=createBench(spec);const ctx={abort:()=>{throw Error('Unexpected abort');}};
  const write=await bench.execute({action:'write',file:'solution.js',content:spec.task.reference},ctx);assert.equal(JSON.parse(write.content[0].text).sourceSha256,hash(spec.task.reference));
  assert.equal((await bench.execute({action:'test'},ctx)).isError,false);assert.equal((await bench.execute({action:'test'},ctx)).isError,false);
  const rows=fs.readFileSync(spec.receipt,'utf8').trim().split('\n').map(JSON.parse);const checks=rows.filter(row=>row.action==='test');
  assert.equal(checks[0].redundantTest,true);
  assert.equal(checks[1].redundantTest,true);
  const changedSource=spec.task.reference+'\n';
  await bench.execute({action:'write',file:'solution.js',content:changedSource},ctx);await bench.execute({action:'test'},ctx);
  const last=fs.readFileSync(spec.receipt,'utf8').trim().split('\n').map(JSON.parse).at(-1);assert.equal(last.redundantTest,false);
});

test('combined acceptance requires done, correct behavior and matching public evidence',async()=>{
  const task=tasks[0],data=await materialize(task),hidden={passed:true};
  const done=[{type:'finish',status:'done'}];
  const unrelated=task.reference+'\n';
  assert.equal(outcomes(task,data,unrelated,hidden,done).taskPassed,false);
  assert.equal(outcomes(task,data,unrelated,hidden,done).falseCompletion,true);
  assert.equal(outcomes(task,data,task.reference,hidden,done).taskPassed,true);
  assert.equal(outcomes(task,data,task.reference,hidden,[]).taskPassed,false);
  const receipt={type:'tool',action:'test',ok:true,sourceHash:hash(unrelated),suiteHash:hash(JSON.stringify(task.publicCases))};
  assert.equal(outcomes(task,data,unrelated,hidden,[receipt,...done]).taskPassed,true);
  assert.equal(outcomes(task,data,unrelated,{passed:false},[receipt,...done]).taskPassed,false);
  assert.equal(outcomes(task,data,unrelated,hidden,[{...receipt,suiteHash:'wrong'},...done]).taskPassed,false);
});

test('tool call cap and immutable input guard abort rather than keep executing',async context=>{
  const spec=await fixture(context);let aborted=false;const ctx={abort:()=>{aborted=true;}};const bench=createBench(spec);
  for(let index=0;index<21;index++)await bench.execute({action:'read',file:'workspace.json'},ctx);
  assert.equal(aborted,true);const rows=fs.readFileSync(spec.receipt,'utf8').trim().split('\n').map(JSON.parse);assert.equal(rows.filter(row=>row.type==='tool').length,20);
  const second=createBench({...spec,receipt:spec.receipt+'.other'});fs.appendFileSync(path.join(spec.work,'session.jsonl'),'\n');const result=await second.execute({action:'read',file:'session.jsonl'},ctx);assert.equal(result.isError,true);
  assert.match(fs.readFileSync(spec.receipt+'.other','utf8'),/IMMUTABLE_INPUT_CHANGED/);
});

test('aggregate compares both policies to baseline and never hides invalid trials',()=>{
  const order=['baseline','upfront','ondemand'].map(arm=>({id:arm,task:'one',repeat:0,arm}));
  const rows=order.map(item=>({...item,valid:true,behaviorPassed:true,verificationSatisfied:true,taskPassed:true,tokens:{totalTokens:item.arm==='baseline'?100:120},toolCalls:3,endToEndMs:10,initialCliMs:0,modelMs:8,toolMs:2,cliToolMs:0,setupMs:1,evaluationMs:1}));
  const summary=aggregate({order},rows);assert.equal(summary.complete,true);assert.equal(summary.comparisons['ondemand-minus-baseline'].meanTokenDifference,20);assert.equal(summary.comparisons['upfront-minus-baseline'].ties,1);
  assert.equal(summary.realTasks,0);assert.deepEqual(aggregate({order},rows.slice(0,1)).missing,['upfront','ondemand']);
  assert.deepEqual(aggregate({order},[{...rows[0],valid:false}]).invalid,['baseline']);
});
