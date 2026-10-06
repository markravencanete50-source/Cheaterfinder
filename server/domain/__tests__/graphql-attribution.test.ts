import { describe, it, expect } from "vitest";
import { endpointFamilyFromUrl } from "../ig-circuit-breaker.js";
import { GRAPHQL_FRIENDSHIP_QUERY_HASH, graphqlRosterPageSize } from "../ig-graphql-queries.js";
describe("GraphQL roster endpoint attribution",()=>{
  it("allows only explicit 100/200 page experiments; ordinary/invalid sizes stay bounded",()=>{
    for (const size of [1,12,50,100,200]) expect(graphqlRosterPageSize(size)).toBe(size);
    for (const size of [51,99,201,1000,NaN,Infinity]) expect(graphqlRosterPageSize(size)).toBe(50);
    expect(graphqlRosterPageSize(-1)).toBe(1);
    expect(graphqlRosterPageSize(12.9)).toBe(12);
  });
  it("maps the exact request-builder query hashes without conflating dimensions",()=>{
    for(const [family,hash] of Object.entries(GRAPHQL_FRIENDSHIP_QUERY_HASH)) {
      expect(endpointFamilyFromUrl(`https://www.instagram.com/graphql/query/?query_hash=${hash}&variables=%7B%7D`)).toBe(family);
    }
  });
  it("does not guess from an unknown query or unrelated URL",()=>{
    expect(endpointFamilyFromUrl("/graphql/query/?query_hash=unknown&variables=followers")).toBe("other");
    expect(endpointFamilyFromUrl("/anything?query_hash="+GRAPHQL_FRIENDSHIP_QUERY_HASH.followers)).toBe("other");
    expect(endpointFamilyFromUrl("https://[")).toBe("other");
    expect(endpointFamilyFromUrl("/api/v1/friendships/123/following/?count=50")).toBe("following");
  });
});
