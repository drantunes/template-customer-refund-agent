export type DeterministicRecord = Record<string, unknown>;
export declare const SUPPORTED_AXES: readonly string[];
export declare function evaluateDatasetAssertions(
  assertions: DeterministicRecord,
  observed: DeterministicRecord,
): Record<string, boolean>;
export declare function truthForDatasetCase(
  axis: string,
  assertions: DeterministicRecord,
): DeterministicRecord;
export declare function scorerInputFromObservation(
  axis: string,
  observed: DeterministicRecord,
): DeterministicRecord;
export declare function scoreAxis(
  axis: string,
  output: DeterministicRecord,
  truth: DeterministicRecord,
): number;
