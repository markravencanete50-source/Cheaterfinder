// Redis-only diagnostic. No Queue constructors, metadata writes, job mutation,
// Instagram calls or opaque cursors. Shows up to100 completed recurring ticks.
import "dotenv/config";
import Redis from "ioredis";
const since=process.argv[2] ?? "2026-09-08T02:48:33.850Z";
if (!Number.isFinite(Date.parse(since))) throw new Error("Valid observation start required");
const redis=new Redis(process.env.REDIS_URL||"redis://127.0.0.1:6379");
try {
  const jobs=[];
  const ids=await redis.zrevrange("bull:collection-roster:completed",0,99);
  for (const id of ids) {
    const [processed,finished,value]=await redis.hmget(`bull:collection-roster:${id}`,"processedOn","finishedOn","returnvalue");
    if (!processed || !finished || Number(processed)<Date.parse(since)) continue;
    const result=value?JSON.parse(value):null;
    jobs.push({processedAt:new Date(Number(processed)).toISOString(),finishedAt:new Date(Number(finished)).toISOString(),result});
  }
  const successful=jobs.filter(j=>j.result?.status==="syncing" || j.result?.status==="complete").reverse();
  const gaps=successful.slice(1).map((job,index)=>Date.parse(job.processedAt)-Date.parse(successful[index].finishedAt));
  console.log(JSON.stringify({at:new Date().toISOString(),since,readOnly:true,
    summary:{completedTicks:jobs.length,usefulBatches:successful.length,nothingDue:jobs.filter(j=>j.result?.skipped==="nothing-due").length,
      pages:successful.reduce((sum,j)=>sum+(j.result.pages??0),0),gapsBetweenUsefulBatchesMs:gaps},jobs},null,2));
}finally{await redis.quit();}
