import type { SourceLocation } from './types';

export type CfgNode = {
    ctxId: number;
    loc: SourceLocation;
    locIndex: number;
};

export type Cfg = {
    byCtxId: Map<number, CfgNode>;
    entries: CfgNode[];
    returns: CfgNode[];
};

export function buildCfg(locations: readonly SourceLocation[]): Cfg {
    const byCtxId = new Map<number, CfgNode>();
    const entries: CfgNode[] = [];
    const returns: CfgNode[] = [];

    for (let i = 0; i < locations.length; i++) {
        const loc = locations[i];
        const node: CfgNode = { ctxId: loc.ctxId, loc, locIndex: i };
        byCtxId.set(loc.ctxId, node);
        if (loc.firstStatement) entries.push(node);
        if (loc.ret) returns.push(node);
    }

    return { byCtxId, entries, returns };
}

export function traceBack(cfg: Cfg, startCtxId: number, maxDepth = 50): CfgNode[] {
    const chain: CfgNode[] = [];
    let current = cfg.byCtxId.get(startCtxId);
    const visited = new Set<number>();

    while (current && chain.length < maxDepth) {
        chain.push(current);
        visited.add(current.ctxId);
        const reqId = current.loc.reqCtxId;
        if (reqId === undefined) break;
        if (visited.has(reqId)) break;
        current = cfg.byCtxId.get(reqId);
    }

    return chain;
}

export function findAncestorCap(
    cfg: Cfg,
    retCtxId: number,
    lineHits: (file: string, line: number) => number,
): number | undefined {
    const chain = traceBack(cfg, retCtxId);
    if (chain.length < 2) return undefined;

    // Walk backwards from return, skip the return itself, find first ancestor with hits
    // on a DIFFERENT line (same-line ancestor = same inflation, useless for cap)
    const retNode = chain[0];
    for (let i = 1; i < chain.length; i++) {
        const ancestor = chain[i];
        if (ancestor.loc.file !== retNode.loc.file || ancestor.loc.line !== retNode.loc.line) {
            const hits = lineHits(ancestor.loc.file, ancestor.loc.line);
            if (hits > 0) return hits;
        }
    }

    return undefined;
}

export function findFunctionEntry(cfg: Cfg, funcName: string, file: string): CfgNode | undefined {
    return cfg.entries.find(e => e.loc.func === funcName && e.loc.file === file);
}
