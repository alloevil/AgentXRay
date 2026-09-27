const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {hash,executeCli}=require('../layered-comparison/bench.cjs');

function grade(node,source,cases){
  const evaluator=path.join(__dirname,'evaluate.cjs');
  const result=spawnSync(node,['--permission',`--allow-fs-read=${evaluator}`,'--max-old-space-size=64',evaluator],{
    input:JSON.stringify({source,cases}),encoding:'utf8',timeout:4000,maxBuffer:100000,env:{PATH:process.env.PATH}});
  if(result.error||result.status!==0)throw Error('EVALUATOR_FAILED');
  const output=JSON.parse(result.stdout);if(typeof output.passed!=='boolean'||!Array.isArray(output.cases)||output.cases.length!==cases.length)throw Error('EVALUATOR_INVALID');
  return output;
}

const CALL_LIMIT=20;
function createBench({work,receipt,node,arm,verifiedSources=[]}) {
  const allowed=['solution.js','public-tests.json','session.jsonl','workspace.json'];
  const initial=Object.fromEntries(allowed.filter(file=>file!=='solution.js').map(file=>[file,fs.readFileSync(path.join(work,file),'utf8')]));
  const suiteHash=hash(JSON.stringify(JSON.parse(initial['public-tests.json'])));
  const verified=new Set(verifiedSources);
  const append=row=>fs.appendFileSync(receipt,JSON.stringify(row)+'\n',{mode:0o600});
  let calls=0,finished=false;
  async function execute(params,context){
    calls++;
    if(finished||calls>CALL_LIMIT){append({type:'budget-stop',call:calls});context.abort();return {isError:true,content:[{type:'text',text:'Tool budget exhausted or task already submitted.'}]};}
    const started=performance.now();
    const before=fs.readFileSync(path.join(work,'solution.js'),'utf8');
    const beforeHash=hash(before);
    let output,ok=true,cli=null,redundantTest=false;
    try{
      for(const [file,text]of Object.entries(initial))if(fs.readFileSync(path.join(work,file),'utf8')!==text)throw Error('IMMUTABLE_INPUT_CHANGED');
      if(params.action==='read'){
        if(!allowed.includes(params.file)){ok=false;output={error:'File outside allowlist.'};}
        else output={file:params.file,content:fs.readFileSync(path.join(work,params.file),'utf8')};
      }else if(params.action==='write'){
        if(params.file!=='solution.js'||typeof params.content!=='string'||Buffer.byteLength(params.content)>24000){ok=false;output={error:'Only solution.js, at most 24000 bytes, may be written.'};}
        else{fs.writeFileSync(path.join(work,'solution.js'),params.content);output={written:'solution.js',sourceSha256:hash(params.content),suiteSha256:suiteHash};}
      }else if(params.action==='test'){
        redundantTest=verified.has(beforeHash);
        const result=grade(node,before,JSON.parse(initial['public-tests.json']));
        ok=result.passed;if(ok)verified.add(beforeHash);
        output={...result,sourceSha256:beforeHash,suiteSha256:suiteHash};
      }else if(['inspect','evidence'].includes(params.action)){
        if(arm==='baseline'){ok=false;output={error:'AgentXRay is unavailable in this baseline. Raw history and public checks remain available.'};}
        else{
          try{cli=executeCli(node,path.join(work,'session.jsonl'),params);output=cli.text;ok=cli.code===0;}
          catch(error){if(['INVALID_VIEW','INVALID_EVIDENCE_ARGUMENTS'].includes(error.message)){ok=false;output={error:error.message};}else throw error;}
        }
      }else if(params.action==='finish'&&['done','blocked'].includes(params.status)){
        finished=true;append({type:'finish',status:params.status,sourceHash:beforeHash});output={submitted:params.status,instruction:'Return a short final answer without additional tools.'};
      }else{ok=false;output={error:'Unsupported action or status.'};}
    }catch(error){append({type:'infrastructure-stop',call:calls,reason:/^[A-Z_]+$/.test(error.message)?error.message:'INFRASTRUCTURE_FAILED'});context.abort();return {isError:true,content:[{type:'text',text:'Trial stopped by infrastructure; do not retry.'}]};}
    const text=typeof output==='string'?output:JSON.stringify(output);
    const response={isError:!ok,content:[{type:'text',text}]};
    const semantic=[params.action,params.file??null,params.view??null,params.sha256??null,params.line??null,params.offset??null,params.maxBytes??null,
      typeof params.content==='string'?hash(params.content):null,params.status??null,beforeHash];
    append({type:'tool',call:calls,action:params.action,file:params.file||null,view:params.view||null,line:params.line??null,offset:params.offset??null,
      ok,redundantTest,beforeHash,sourceHash:hash(fs.readFileSync(path.join(work,'solution.js'))),suiteHash,inputHash:hash(JSON.stringify(semantic)),outputHash:hash(text),
      responseTextBytes:Buffer.byteLength(text),responseEnvelopeBytes:Buffer.byteLength(JSON.stringify(response)),cliMs:cli?.elapsedMs||0,cliExit:cli?.code??null,
      truncated:cli?.report.truncated??null,errorCode:cli?.report.error?.code||null,elapsedMs:performance.now()-started});
    return response;
  }
  return {execute};
}
module.exports={createBench,CALL_LIMIT,hash,grade,executeCli};
