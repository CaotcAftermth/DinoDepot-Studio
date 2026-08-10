export type IssueLevel = "error" | "warning";

export interface ValidationIssue {
  level: IssueLevel;
  /** Editor entity the issue belongs to (rule id, remap id, …). */
  entityId: string;
  /** Human-readable location, e.g. "Cycle 2 › Item 1 › Alternate 3". */
  where: string;
  message: string;
}

export function countIssues(issues: ValidationIssue[]): {
  errors: number;
  warnings: number;
} {
  let errors = 0;
  let warnings = 0;
  for (const issue of issues) {
    if (issue.level === "error") errors++;
    else warnings++;
  }
  return { errors, warnings };
}
