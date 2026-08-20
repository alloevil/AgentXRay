// Re-export surface for the generated legacy bundle (public/js/pure.js).
// scripts/build-legacy-pure.mjs bundles this file with esbuild; the footer
// exposes every export as a window/global function for the frozen vanilla UI
// and as module.exports for the node tests.

export {
  formatBytes,
  parseTimestampMs,
  formatDurationCompact,
  formatCost,
  firstInformativeLine,
  getTextContent,
  clusterPrefillContent,
  buildTraceTurns,
} from './pure';
export { escapeHtml, renderMarkdownHtml, renderMarkdown } from './markdown';
