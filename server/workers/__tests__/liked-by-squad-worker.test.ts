import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {markShuttingDown,resetShutdownStateForTests} from "../../services/shutdown-state.js";
const {load,follow,harvest}=vi.hoisted(()=>({load:vi.fn(),follow:vi.fn(),harvest:vi.fn()}));
vi.mock("../../services/liked-by-harvester.js",()=>({loadWatcherBotIds:load,ensureWatcherFollows:follow,harvestLikedBy:harvest,isRotateSignal:()=>false}));
import {__testing} from "../liked-by-squad-worker.js";
beforeEach(()=>{
  resetShutdownStateForTests();load.mockReset();follow.mockReset();harvest.mockReset();
  load.mockResolvedValue(["reader-1","reader-2"]);
  follow.mockResolvedValue({followed:1,probed:1,cached:2});
  harvest.mockResolvedValue({inserted:3,matched:3,fetchedPosts:10});
});
afterEach(()=>resetShutdownStateForTests());
describe("squad cooperative shutdown keeps completed work",()=>{
  it("normal operation still visits both kinds and preserves all results",async()=>{
    expect(await __testing.runHarvestSweep()).toMatchObject({watchers:4,followed:4,inserted:12,errors:0,stoppedEarly:false});
    expect(harvest).toHaveBeenCalledTimes(4);
  });
  it("does not start even the pool lookup when already draining",async()=>{
    markShuttingDown();expect(await __testing.runHarvestSweep()).toMatchObject({watchers:0,inserted:0,errors:0,stoppedEarly:true});
    expect(load).not.toHaveBeenCalled();expect(follow).not.toHaveBeenCalled();expect(harvest).not.toHaveBeenCalled();
  });
  it("keeps completed follow maintenance without starting another read",async()=>{
    follow.mockImplementation(async()=>{markShuttingDown();return {followed:1,probed:2,cached:3};});
    expect(await __testing.runHarvestSweep()).toMatchObject({followed:1,probed:2,cached:3,inserted:0,stoppedEarly:true});
    expect(harvest).not.toHaveBeenCalled();expect(follow).toHaveBeenCalledTimes(1);
  });
  it("awaits an in-flight harvest result instead of discarding captured data",async()=>{
    harvest.mockImplementation(async()=>{markShuttingDown();await Promise.resolve();return {inserted:7,matched:7,fetchedPosts:10};});
    expect(await __testing.runHarvestSweep()).toMatchObject({followed:1,inserted:7,errors:0,stoppedEarly:true});
    expect(harvest).toHaveBeenCalledTimes(1);expect(load).toHaveBeenCalledTimes(1);
  });
  it("retains a real error but does not rotate through the whole pool during drain",async()=>{
    follow.mockImplementation(async()=>{markShuttingDown();throw new Error("failed current operation");});
    expect(await __testing.runHarvestSweep()).toMatchObject({errors:1,inserted:0,stoppedEarly:true});
    expect(follow).toHaveBeenCalledTimes(1);expect(load).toHaveBeenCalledTimes(1);
  });
});
