/** The error text the worker records for a failed job. */
export function jobErrorCode(error: unknown) {
  return error instanceof Error ? error.message : "JOB_FAILED";
}

/** Errors a retry cannot cure: the worker stops such a job at once. */
export function retryableJobError(code: string) {
  return !/BUDGET|NOT_|REQUIRED|EXPIRED|EVIDENCE|CAPABILITY|POLICY|PAUSED|UNKNOWN|REFUSAL|UNSUPPORTED/.test(
    code,
  );
}
