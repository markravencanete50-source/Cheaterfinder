import { createServer, createConnection, type Socket } from "node:net";

/** Actual TCP fault at PostgreSQL's protocol boundary, not db.execute mocking.
 * Hold INSERT CommandComplete, wait for ReadyForQuery/Idle (implicit COMMIT),
 * then disconnect without forwarding the acknowledgement. An independent
 * direct-DB observer MUST also verify the committed rows in the scenario.
 * https://www.postgresql.org/docs/16/protocol-flow.html
 * https://www.postgresql.org/docs/16/protocol-message-formats.html
 */
export async function startPgFaultProxy(destinationPort: number, listenPort: number) {
  const sockets=new Set<Socket>();
  const control={offline:false,dropNextInsertAck:false,ackDrops:0,rejectedConnections:0};
  const server=createServer(client=>{
    if(control.offline){control.rejectedConnections++;client.destroy();return;}
    const backend=createConnection({host:"127.0.0.1",port:destinationPort});
    for(const s of [client,backend]){sockets.add(s);s.once("close",()=>sockets.delete(s));s.on("error",()=>{client.destroy();backend.destroy();});}
    client.on("close",()=>backend.destroy());backend.on("close",()=>client.destroy());
    client.pipe(backend);
    let buffered=Buffer.alloc(0),withholding=false;
    backend.on("data",chunk=>{
      buffered=Buffer.concat([buffered,chunk]);
      while(buffered.length>=5){
        const length=buffered.readInt32BE(1)+1;
        if(length<5||length>32*1024*1024){client.destroy();backend.destroy();return;}
        if(buffered.length<length)return;
        const frame=buffered.subarray(0,length);buffered=buffered.subarray(length);
        const tag=String.fromCharCode(frame[0]);
        if(control.dropNextInsertAck&&tag==="C"&&frame.subarray(5).toString().startsWith("INSERT ")){
          control.dropNextInsertAck=false;withholding=true;
        }
        if(withholding){
          if(tag==="Z"){
            if(frame[5]!=="I".charCodeAt(0))throw new Error("Fault expected autocommit INSERT, not an open transaction");
            control.ackDrops++;client.destroy();backend.destroy();return;
          }
        } else client.write(frame);
      }
    });
  });
  await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(listenPort,"127.0.0.1",resolve);});
  return {
    control,
    disconnectAll(){for(const s of sockets)s.destroy();},
    async close(){for(const s of sockets)s.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));},
  };
}
export type PgFaultProxy=Awaited<ReturnType<typeof startPgFaultProxy>>;
