import type { RunReportAction } from '@isar-flow/core';

export const EXPORT_RUN_REPORT_COMMAND = 'isarFlow.exportRunReport';
export const COPY_RUN_FOR_PR_COMMAND = 'isarFlow.copyRunForPr';

/** The command behind each report action of the canvas (Runs menu, run summary). */
export const REPORT_COMMANDS: Record<RunReportAction, string> = {
  export: EXPORT_RUN_REPORT_COMMAND,
  copyForPr: COPY_RUN_FOR_PR_COMMAND,
};
