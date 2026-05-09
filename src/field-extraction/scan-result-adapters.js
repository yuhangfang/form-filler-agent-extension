(function (g) {
  function getScanPayload(source) {
    return source?.scan || {};
  }

  function getLlmInputEntries(source) {
    const scan = getScanPayload(source);
    if (Array.isArray(scan.llmInput)) return scan.llmInput;
    if (Array.isArray(scan.llmInputs)) return scan.llmInputs;
    return [];
  }

  function getBrowserSnapshotText(source) {
    const scan = getScanPayload(source);
    return String(scan.snapshot_text || scan.snapshotText || "");
  }

  function getDomOutline(source) {
    const scan = getScanPayload(source);
    return String(scan.domOutline || scan.dom_outline || "");
  }

  function getParsedFieldScan(source) {
    return source?.scan?.parsedFieldScan || source?.scan?.parsed_field_scan || null;
  }

  function getSnapshotScanView(source) {
    const parsed = getParsedFieldScan(source);
    if (!parsed) {
      return {
        ok: false,
        error: "Snapshot parser result is missing. Reload the extension and run again."
      };
    }
    return { ok: !!parsed.ok, error: parsed.error || "", scan: parsed };
  }

  g.ScanResultAdapters = {
    getScanPayload,
    getLlmInputEntries,
    getBrowserSnapshotText,
    getDomOutline,
    getParsedFieldScan,
    getSnapshotScanView
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
