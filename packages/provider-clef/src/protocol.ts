export interface ClefQuestion {
  readonly type: "choice" | "noul";
  readonly instructions: unknown;
  readonly criteria: Readonly<Record<string, unknown>>;
}
export interface ClefRequest {
  readonly model: string;
  readonly state: unknown;
  readonly questions: Readonly<Record<string, ClefQuestion>>;
}
export const choice = (
  instructions: unknown,
  criteria: Readonly<Record<string, unknown>>,
): ClefQuestion => ({ type: "choice", instructions, criteria });
export const noul = (
  instructions: unknown,
  criteria: Readonly<Record<string, unknown>>,
): ClefQuestion => ({ type: "noul", instructions, criteria });
