export { Change, diff, presentableDiff, DiffConfig } from "./diff";

export { getChunks, goToNextChunk, goToPreviousChunk } from "./merge";

export { MergeConfig, DirectMergeConfig, MergeView } from "./mergeview";

export {
  unifiedMergeView,
  acceptChunk,
  rejectChunk,
  acceptAllChunks,
  rejectAllChunks,
  getOriginalDoc,
  originalDocChangeEffect,
  updateOriginalDoc,
  generateCodeEffect,
  applyGeneratedCode,
} from "./unified";

export { uncollapseUnchanged } from "./deco";

export { Chunk } from "./chunk";
