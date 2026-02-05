import {
  type Condition,
  Condition_Status,
  type Run,
} from "../protogen/oaiproto/aisre/runs_pb.js";

export enum ConditionType {
  Done = "Done",
  Succeeded = "Succeeded",
  InProgress = "InProgress",
  Completed = "Completed",
  MaxTurns = "MaxTurns",
  Started = "Started",
  EndRun = "EndRun",
  Error = "Error",
}

export function getMostRecentCondition(
  conditions: Condition[],
  condType: ConditionType,
) {
  let latest: Condition | undefined;

  for (const condition of conditions) {
    if (condition.type === condType) {
      if (
        latest == null ||
        (condition.lastTransitionTime?.seconds ?? 0) >
          (latest.lastTransitionTime?.seconds ?? 0)
      ) {
        latest = condition;
      }
    }
  }

  return latest;
}

export function isRunDone(run: Run) {
  const condition = getMostRecentCondition(run.conditions, ConditionType.Done);
  return condition?.status === Condition_Status.TRUE;
}
