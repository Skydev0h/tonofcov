/**
 * Shared types for tonofcov internals.
 */

/**
 * A source-level location for a particular offset in a compiled code cell.
 * Shape matches @ton-community/func-js LocationEntry; we keep the fields we
 * care about explicit so the rest of the codebase is decoupled from func-js
 * minor version bumps.
 */
export type SourceLocation = {
    file: string;
    line: number;
    func: string;
    /** True if this location marks a statement boundary (executable line). */
    firstStatement?: boolean;
    /** True if this location is a return point. */
    ret?: boolean;
    /** Present if this is a branch decision point. The true/false side context ids. */
    branchTrueCtxId?: number;
    branchFalseCtxId?: number;
    /** For try/catch blocks. */
    tryCatchCtxId?: number;
    isTryEnd?: boolean;
    ctxId: number;
};

/**
 * Bundle of debug information for a single compiled contract.
 * Produced once at compile time, looked up many times during aggregation.
 */
export type CompiledDebugInfo = {
    /** Hex string, lowercase, 64 chars. */
    rootCodeHash: string;
    /** SourceLocation table indexed by key (the numbers that appear in marks). */
    locations: readonly SourceLocation[];
    /**
     * For each inner cell: map offset (bit position) to the keys (into locations)
     * that apply at that point. Offsets can have multiple keys (statement + branch, etc.).
     * Cell hash keys are UPPERCASE hex, matching vmLog output.
     */
    marks: ReadonlyMap<string, ReadonlyMap<number, readonly number[]>>;
};

/**
 * A single observed execution step at the TVM level — derived from vmLog.
 */
export type Step = {
    /** UPPERCASE hex cell hash, as emitted by vmLog. */
    cellHash: string;
    /** Bit offset within the cell. */
    offset: number;
    /** Instruction mnemonic, e.g. "PUSHINT". Informational only. */
    opcode?: string;
    /** Gas consumed by this step (computed as delta of gas-remaining, so last step lacks it). */
    gas?: number;
    /** True if this step raised a handleable exception. */
    exceptionRaised?: boolean;
    /** True if this step terminated the VM with an unhandled exception. */
    exceptionFatal?: boolean;
};

/**
 * Aggregated line coverage for a single source file.
 */
export type FileCoverage = {
    file: string;
    /** Line number → aggregated stats. */
    lines: Map<number, LineStats>;
    /** Line number → branch stats. */
    branches: Map<number, BranchStats[]>;
    /** Functions seen (via func field), with first-seen line for FN record. */
    functions: Map<string, FunctionStats>;
};

export type LineStats = {
    hits: number;
    totalGas: number;
    /** Times a THROW* opcode on this line actually raised (conditional throws that fired). */
    throws?: number;
};

export type BranchStats = {
    /** Distinct branches at the same line get separate block ids, 0-based. */
    blockId: number;
    /** Hits on the true side (branch_true_ctx_id executed after). */
    taken: number;
    /** Hits on the false side (branch_false_ctx_id executed after, or fall-through). */
    notTaken: number;
};

export type FunctionStats = {
    firstLine: number;
    hits: number;
};

/**
 * Top-level aggregation result — consumed by the LCOV emitter.
 */
export type Coverage = {
    files: Map<string, FileCoverage>;
};
