// Fast, pure diagnostics before the database's publish_screening_run RPC
// performs the authoritative transactional checks. This helper never marks a
// run published and never pretends to verify storage objects; object existence
// is checked inside PostgreSQL against storage.objects.

export function validatePublicationCounts(snapshot) {
  const errors = [];
  if (!(snapshot.expectedEquities > 0)) errors.push("expected equity universe is empty");
  if (snapshot.expectedIndexes !== 4) errors.push(`expected 4 index instruments, found ${snapshot.expectedIndexes}`);
  if (snapshot.universeSources !== 4) errors.push(`expected 4 immutable universe source snapshots, found ${snapshot.universeSources}`);
  if (snapshot.resultEquities !== snapshot.expectedEquities) errors.push("equity result count does not match expected universe");
  if (snapshot.resultIndexes !== snapshot.expectedIndexes) errors.push("index result count does not match expected universe");
  if (snapshot.alignmentEquities !== snapshot.expectedEquities) errors.push("alignment count does not match expected equity universe");
  if (snapshot.directionRows !== snapshot.eligibleEquities * 3) errors.push("eligible equities do not each have Monthly, Weekly and Daily Direction rows");
  if (snapshot.chartRows !== snapshot.directionRows) errors.push("one or more Direction rows lack an immutable chart path/hash");
  if (snapshot.analysisBarEquities !== snapshot.eligibleEquities) errors.push("one or more eligible equities lack run-scoped analysisBars");
  if (snapshot.traceEquities !== snapshot.eligibleEquities) errors.push("one or more eligible equities lack canonical rule traces");
  if (snapshot.missingAlignedAnalysis > 0) errors.push("one or more aligned equities lack their directional Analysis artifact");
  if (snapshot.missingStorageObjects > 0) errors.push("one or more immutable chart objects are missing from storage metadata");
  if (snapshot.criticalPersistenceErrors > 0) errors.push("critical persistence errors were recorded");
  if (snapshot.futureAnalysisBars > 0) errors.push("analysisBars contain data newer than the frozen cutoff");
  if (snapshot.incompleteAnalysisBars > 0) errors.push("analysisBars contain incomplete candles");
  if (!snapshot.coverageReconciled) errors.push("coverage reconciliation failed");
  return { valid: errors.length === 0, errors };
}
