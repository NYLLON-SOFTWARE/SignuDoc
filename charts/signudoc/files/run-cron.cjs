function noFailures(errors) {
  return Array.isArray(errors) && errors.length === 0;
}

function isCompletedSummary(path, summary) {
  if (
    !summary ||
    (summary.status !== undefined && summary.status !== "ran") ||
    summary.stoppedEarly === true ||
    summary.schedule?.stoppedEarly === true
  ) {
    return false;
  }

  if (path === "/api/internal/backup") {
    return (
      typeof summary.databaseBackup === "string" &&
      summary.databaseBackup.trim().length > 0 &&
      summary.stoppedEarly === false &&
      noFailures(summary.fileFailures)
    );
  }

  return (
    path === "/api/internal/retention" &&
    Number.isFinite(summary.ranAt) &&
    summary.schedule?.stoppedEarly === false &&
    [
      summary.accountPurgeFailures,
      summary.draftDeletionFailures,
      summary.finishedEnvelopeDeletionFailures,
      summary.schedule.expiryNoticeFailures,
      summary.schedule.reminderFailures,
    ].every(noFailures)
  );
}

async function main() {
  const { JOB_URL } = process.env;
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || !JOB_URL) {
    console.error("Scheduled request is missing its URL or credentials.");
    process.exitCode = 1;
    return;
  }

  const url = new URL(JOB_URL);
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}` },
    redirect: "manual",
    signal: AbortSignal.timeout(270_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    console.error(`Scheduled request returned HTTP ${response.status}.`);
    process.exitCode = 1;
    return;
  }

  const summary = await response.json();
  if (!isCompletedSummary(url.pathname, summary)) {
    console.error("Scheduled request did not return a completed run summary.");
    process.exitCode = 1;
  }
}

main().catch(() => {
  console.error("Scheduled request failed.");
  process.exitCode = 1;
});
