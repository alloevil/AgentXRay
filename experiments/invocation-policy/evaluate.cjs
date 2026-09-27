const fs=require('node:fs');
const vm=require('node:vm');
const {isDeepStrictEqual}=require('node:util');
const request=JSON.parse(fs.readFileSync(0,'utf8'));
const cases=[];
for(const entry of request.cases){
  try{
    const source=`${request.source}\nconst benchmarkInput=JSON.parse(${JSON.stringify(JSON.stringify(entry.input))}); JSON.stringify({actual:solve(benchmarkInput),after:benchmarkInput});`;
    const encoded=new vm.Script(source).runInNewContext(Object.create(null),{timeout:250,contextCodeGeneration:{strings:false,wasm:false}});
    const result=JSON.parse(encoded);
    const unchanged=isDeepStrictEqual(result.after,entry.input);
    cases.push({passed:isDeepStrictEqual(result.actual,entry.expected)&&unchanged,actual:result.actual,inputUnchanged:unchanged});
  }catch(error){cases.push({passed:false,error:String(error.message).slice(0,200)});}
}
process.stdout.write(JSON.stringify({passed:cases.every(entry=>entry.passed),cases}));
